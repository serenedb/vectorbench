/* The full-screen graph: the same drawing, as big as the window, with a row
   list on the right — toggle rows in as additional vertical lines and, for
   rows of other groups, additional point sets (dashed by group). */

import { useMemo, type Dispatch, type ReactNode } from 'react';
import type { DatasetModel, Grid, ResultModel } from '../../entities/results';
import { fmtRecall, metricUnit } from '../../shared/lib/format';
import { VIEW_LABELS, type BenchAction, type BenchState } from '../../shared/model';
import { Modal } from '../../shared/ui';
import { CurveGraph, GraphLegend } from './CurveGraph';
import { buildGraphData } from './graphData';
import { useSize } from './useSize';

export function FullGraphModal({ dataset, results, grid, state, dispatch }: { dataset: DatasetModel; results: readonly ResultModel[]; grid: Grid; state: BenchState; dispatch: Dispatch<BenchAction> }): ReactNode {
  const selected = state.graphRows ?? [];
  const rows = useMemo(() => dataset.queries.filter((q) => selected.includes(q.id)), [dataset, selected]);
  const data = useMemo(() => buildGraphData(results, rows, grid), [results, rows, grid]);
  const [ref, size] = useSize<HTMLDivElement>();
  const close = () => dispatch({ type: 'graph-close' });
  return (
    <Modal kicker="curves" title={`${dataset.id} · ${VIEW_LABELS[grid.view]} · y = ${grid.metric} (${metricUnit(grid.metric)}), log`} meta={`${rows.length} row${rows.length === 1 ? '' : 's'} · ${data.groups.length} group${data.groups.length === 1 ? '' : 's'}`} role="full-graph" width="96vw" height="92vh" onClose={close}>
      <div style={{ display: 'flex', gap: 16, height: '100%', minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div ref={ref} style={{ flex: 1, minHeight: 0 }}>
            {size.width > 0 && size.height > 0 && <CurveGraph data={data} metric={grid.metric} width={size.width} height={size.height} />}
          </div>
          <GraphLegend data={data} />
        </div>
        <div className="rlist" style={{ width: 250, flexShrink: 0, overflow: 'auto' }}>
          {(['nofilter', 'filtered'] as const).map((section) => (
            <div key={section}>
              <div className="rs">{section === 'nofilter' ? 'NO FILTER' : 'FILTERED'}</div>
              {dataset.queries
                .filter((q) => q.section === section)
                .map((q) => (
                  <label key={q.id} title={q.key}>
                    <input type="checkbox" checked={selected.includes(q.id)} data-act="graph-toggle" data-id={q.id} onChange={() => dispatch({ type: 'graph-toggle', id: q.id })} />
                    <b>{q.id}</b>
                    <span style={{ color: 'var(--mut)' }}>
                      {q.filter} · k={q.k} · {q.exact ? 'exact' : fmtRecall(q.recall)}
                    </span>
                  </label>
                ))}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
