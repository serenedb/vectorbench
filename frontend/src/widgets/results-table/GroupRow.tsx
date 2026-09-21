/* One row per group: every participant read at the strongest bar all of them
   reach, with its own curve drawn in the cell on axes shared across the row.

   The bar-per-row grid spends a row on each recall bar and writes a word where
   a participant's curve stops short of it, which on a filtered group can leave
   a whole column of words and hides that the engine answering them is several
   times faster. Here the bar moves to where everyone can be read, the number
   is always a number, and what each engine reaches on its own stays visible
   next to it. */

import type { ReactNode } from 'react';
import type { GroupRowModel, ParticipantCurve, Point, ResultModel } from '../../entities/results';
import { ratioTo } from '../../entities/results';
import { ratioBg } from '../../shared/lib/color';
import { fmtMetric, fmtRatio, fmtRecall, metricUnit } from '../../shared/lib/format';
import type { CellMode } from '../../shared/model';
import type { Direction, Metric } from '../../entities/results';

const W = 46;
const H = 14;

/** The participant's frontier on axes the whole row shares, so two cells compare by eye. */
function MiniCurve({ front, xLo, xHi, yLo, yHi, color }: { front: readonly Point[]; xLo: number; xHi: number; yLo: number; yHi: number; color: string }): ReactNode {
  if (front.length < 2 || xHi <= xLo || yHi <= yLo) return <svg width={W} height={H} aria-hidden="true" />;
  const lx = Math.log10(yLo);
  const lh = Math.log10(yHi) - lx;
  const X = (r: number) => ((Math.min(Math.max(r, xLo), xHi) - xLo) / (xHi - xLo)) * (W - 2) + 1;
  const Y = (v: number) => H - 1 - ((Math.log10(Math.min(Math.max(v, yLo), yHi)) - lx) / lh) * (H - 2);
  const d = front.map((p, i) => `${i ? 'L' : 'M'}${X(p.recall).toFixed(1)},${Y(p.value).toFixed(1)}`).join('');
  const tip = front[front.length - 1];
  return (
    <svg width={W} height={H} aria-hidden="true" style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" />
      <circle cx={X(tip.recall)} cy={Y(tip.value)} r={1.6} fill={color} />
    </svg>
  );
}

/* A measured recall, three decimals. `fmtRecall` is for the bars a family
   declares (0.90, 0.95, 0.99) and prints the raw float for anything else,
   which on a measured 0.9033000000000001 is nine digits of noise. */
function r3(r: number): string {
  return r >= 0.9995 ? '1.000' : r.toFixed(3);
}

function reachText(c: ParticipantCurve): string {
  return c.reach === null ? '—' : r3(c.reach);
}

export function GroupTableRow({
  row,
  results,
  gridCols,
  metric,
  direction,
  cells,
  colorOf,
  open,
  selected,
  onToggle,
  onCell,
}: {
  row: GroupRowModel;
  results: readonly ResultModel[];
  gridCols: string;
  metric: Metric;
  direction: Direction;
  cells: CellMode;
  colorOf: (pid: string) => string;
  open: boolean;
  selected: string | null;
  onToggle: () => void;
  onCell: (pid: string) => void;
}): ReactNode {
  const live = row.curves.filter((c) => c.front.length > 0);
  const xLo = live.length ? Math.min(...live.map((c) => c.front[0].recall)) : 0;
  const xHi = live.length ? Math.max(...live.map((c) => c.front[c.front.length - 1].recall)) : 1;
  const vals = live.flatMap((c) => c.front.map((p) => p.value)).filter((v) => v > 0);
  const yLo = vals.length ? Math.min(...vals) : 1;
  const yHi = vals.length ? Math.max(...vals) : 1;

  const tags = [
    row.filter === 'none' ? null : row.filter,
    `k=${row.k}`,
    row.exact ? 'exact' : row.bar === null ? 'no common bar' : row.qualityGap ? 'no common bar' : `@ ${r3(row.bar)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const barNote =
    row.barKind === 'declared'
      ? `read at recall ${r3(row.bar as number)}, the strongest bar the family declares that every participant here can be read at`
      : row.barKind === 'common-reach'
        ? row.qualityGap
          ? `no participant-wide bar reaches the weakest the family declares (${fmtRecall(row.floor as number)}): the engines differ in what they can answer here at all, so the row reports what each reaches instead of a speed nobody can be held to`
          : `read at recall ${r3(row.bar as number)} — no declared bar is reachable by every participant, so the row falls back to the strongest recall they all reach`
        : row.barKind === 'exact'
          ? 'exact: every participant answers at recall 1 or not at all'
          : 'no participant has a curve here';

  return (
    <div className="trow" style={{ gridTemplateColumns: gridCols }}>
      <button type="button" className={'rowlab' + (open ? ' open' : '')} data-act="row" data-id={row.key} title={barNote + ' · click for the full curves'} onClick={onToggle}>
        {row.key}
        <span className="mk">{open ? '▾' : ''}</span>
        <span className="tg">{tags}</span>
      </button>
      {results.map((r) => {
        const c = row.curves.find((x) => x.pid === r.id);
        if (!c || c.reach === null) {
          return (
            <div key={r.id} className="cell fail q" title={`${r.name} · no curve for this group`} data-act="cell" data-id={row.key} data-pid={r.id} onClick={() => onCell(r.id)}>
              unsupported
            </div>
          );
        }
        const v = row.qualityGap ? null : c.value;
        const ratio = v !== null && row.best !== null ? ratioTo(v, row.best, direction) : 1;
        const lead = c.lead ? `leads ${fmtRecall(c.lead[0])}–${fmtRecall(c.lead[1])}` : 'never fastest';
        const title =
          `${r.name} · ${row.key} · ` +
          (v === null ? 'no number at the row bar' : `${fmtMetric(metric, v)} ${metricUnit(metric)} · ${fmtRatio(ratio)} of the best`) +
          ` · reaches recall ${reachText(c)} · ${lead} — click for the measurements`;
        return (
          <div
            key={r.id}
            className={'cell q gcell' + (row.qualityGap ? ' fail' : '') + (selected === r.id ? ' sel' : '')}
            style={{ background: v === null ? undefined : ratioBg(ratio) }}
            title={title}
            data-act="cell"
            data-id={row.key}
            data-pid={r.id}
            onClick={() => onCell(r.id)}
          >
            <span className="gv">{row.qualityGap ? 'reaches ' + reachText(c) : v === null ? '—' : cells === 'relative' ? fmtRatio(ratio) : fmtMetric(metric, v)}</span>
            <span className="gsub">
              {!row.qualityGap && (
                <span className="greach" title="highest recall this participant's curve reaches">
                  ↗{reachText(c)}
                </span>
              )}
              <MiniCurve front={c.front} xLo={xLo} xHi={xHi} yLo={yLo} yHi={yHi} color={colorOf(r.id)} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
