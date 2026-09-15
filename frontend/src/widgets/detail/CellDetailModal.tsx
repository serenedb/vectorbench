/* Everything measured for one participant on one query: the status and how
   the number was read, the statement that ran, every point with all its
   statistics, the two bracketing points, the group's memory peak and startup.
   The view can be switched inside the modal, so both curves are one click
   apart; the page's view is the default. */

import { useMemo, useState, type Dispatch, type ReactNode } from 'react';
import {
  LATENCY_METRICS,
  cellFor,
  cellValue,
  dominated,
  groupFor,
  metricFor,
  statusLabel,
  usablePoints,
  type DatasetModel,
  type QueryRow,
  type ResultModel,
} from '../../entities/results';
import { fmtBytes, fmtFrac, fmtGB, fmtInt, fmtKnobs, fmtMetric, fmtMs, fmtQps, fmtRecall, fmtSec, metricUnit } from '../../shared/lib/format';
import { VIEWS, VIEW_LABELS, type BenchAction, type BenchState, type View } from '../../shared/model';
import { Modal, Seg } from '../../shared/ui';

export function CellDetailModal({ dataset, result, row, state, dispatch }: { dataset: DatasetModel; result: ResultModel; row: QueryRow; state: BenchState; dispatch: Dispatch<BenchAction> }): ReactNode {
  const [view, setView] = useState<View>(state.view);
  const metric = metricFor(view, state.latencyMetric);
  const close = () => dispatch({ type: 'detail-close' });
  const group = groupFor(result, row, view);
  const cell = useMemo(() => cellFor(result, row, view, metric), [result, row, view, metric]);
  const value = cellValue(cell);
  const points = group?.points ?? [];
  const usable = useMemo(() => usablePoints(points, metric), [points, metric]);
  const dominatedIdx = useMemo(() => new Set(dominated(usable, metric === 'qps' ? 'higher' : 'lower').map((p) => p.index)), [usable, metric]);
  const bracket = 'a' in cell ? [cell.a.index, cell.b.index] : 'point' in cell ? [cell.point.index] : [];
  const unit = metricUnit(metric);

  return (
    <Modal
      kicker="query detail"
      title={`${result.name} — ${row.id}`}
      meta={`${row.key} · ${row.exact ? 'exact' : 'recall ' + fmtRecall(row.recall)} · ${dataset.id}`}
      role="cell-detail"
      onClose={close}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Seg act="detail-view" opts={VIEWS.map((v) => ({ label: VIEW_LABELS[v], v }))} cur={view} onPick={setView} />
        <span className="sub">
          {group ? `status ${group.status}` : 'group missing from the query file'}
          {group?.clients ? ` · ${group.clients} client${group.clients === 1 ? '' : 's'}` : ''}
          {group?.reason ? ` · ${group.reason}` : ''}
        </span>
      </div>

      <div className="h">the cell</div>
      <div className="kv">
        <span className="k">value</span>
        <span data-role="detail-value">
          {value === null ? '—' : `${fmtMetric(metric, value)} ${unit}`}
          {row.exact ? ' (brute force, recall 1.0)' : ` at recall ${fmtRecall(row.recall)}`} · {metric}
        </span>
        <span className="k">reading</span>
        <span>{statusLabel(cell)}</span>
        {'a' in cell && (
          <>
            <span className="k">bracket a</span>
            <span>
              #{cell.a.index + 1} {fmtKnobs(cell.a.knobs)} · recall {cell.a.recall.toFixed(4)} · {fmtMetric(metric, cell.a.value)} {unit}
            </span>
            <span className="k">bracket b</span>
            <span>
              #{cell.b.index + 1} {fmtKnobs(cell.b.knobs)} · recall {cell.b.recall.toFixed(4)} · {fmtMetric(metric, cell.b.value)} {unit}
            </span>
          </>
        )}
        {'point' in cell && (
          <>
            <span className="k">point</span>
            <span>
              #{cell.point.index + 1} {fmtKnobs(cell.point.knobs)} · recall {cell.point.recall.toFixed(4)} · {fmtMetric(metric, cell.point.value)} {unit}
            </span>
          </>
        )}
        <span className="k">group memory peak</span>
        <span>{group?.memory_peak != null ? `${fmtGB(group.memory_peak)} GB · ${fmtBytes(group.memory_peak)}` : '—'}</span>
        <span className="k">group startup</span>
        <span>{group?.startup != null ? fmtSec(group.startup) + ' s' : '—'}</span>
      </div>

      <div className="h">statement</div>
      <pre className="pre">{group?.block ?? (group ? '(no statement recorded)' : `Not supported: no group ${row.key} in this participant's query file.`)}</pre>

      <div className="h">points · {points.length}</div>
      {points.length === 0 ? (
        <div className="sub">no points</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="dt">
            <thead>
              <tr>
                <th>#</th>
                <th className="l">knobs</th>
                <th>recall</th>
                <th>strict</th>
                <th>tail</th>
                <th className={metric === 'qps' ? 'hl' : ''}>qps</th>
                <th>n</th>
                {LATENCY_METRICS.map((m) => (
                  <th key={m} className={metric === m ? 'hl' : ''}>
                    {m} ms
                  </th>
                ))}
                <th>passes (qps)</th>
                <th>curve</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => {
                const dim = dominatedIdx.has(i);
                const inBracket = bracket.includes(i);
                return (
                  <tr key={i} className={dim ? 'dim' : ''}>
                    <td className={inBracket ? 'ab' : ''}>{i + 1}</td>
                    <td className="l">{fmtKnobs(p.knobs)}</td>
                    <td>{p.recall == null ? '—' : p.recall.toFixed(4)}</td>
                    <td>{p.recall_strict == null ? '—' : p.recall_strict.toFixed(4)}</td>
                    <td>{fmtFrac(p.tail)}</td>
                    <td className={metric === 'qps' ? 'hl' : ''}>{fmtQps(p.qps)}</td>
                    <td>{fmtInt(p.latency_ms?.n)}</td>
                    {LATENCY_METRICS.map((m) => (
                      <td key={m} className={metric === m ? 'hl' : ''}>
                        {fmtMs(p.latency_ms?.[m])}
                      </td>
                    ))}
                    <td>{(p.passes ?? []).map((x) => fmtQps(x.qps)).join(' · ') || '—'}</td>
                    <td>{usable.some((u) => u.index === i) ? (dim ? '○ dominated' : inBracket ? '◆ bracket' : '● frontier') : '— unusable'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="sub" style={{ marginTop: 8 }}>
        recall is tie-aware recall@k over the query set from the first pass; strict is the id-set version; tail is the share of queries below 0.5 recall. qps and the latency
        distribution come from the best pass. Hollow (dominated) points do not enter the curve.
      </div>
    </Modal>
  );
}
