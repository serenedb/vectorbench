/* One row per group: every participant read at the strongest bar all of them
   reach, with its own curve drawn in the cell on axes shared across the row.

   The bar-per-row grid spends a row on each recall bar and writes a word where
   a participant's curve stops short of it, which on a filtered group can leave
   a whole column of words and hides that the engine answering them is several
   times faster. Here the bar moves to where everyone can be read, the number
   is always a number, and what each engine reaches on its own stays visible
   next to it. */

import type { MouseEvent, ReactNode } from 'react';
import type { GroupRowModel, ParticipantCurve, ResultModel } from '../../entities/results';
import { ratioTo, rowTitle } from '../../entities/results';
import { ratioBg } from '../../shared/lib/color';
import { fmtMetric, fmtRatio, fmtRecall, metricUnit } from '../../shared/lib/format';
import type { CellMode } from '../../shared/model';
import type { Direction, Metric } from '../../entities/results';
import { PICK_TITLE } from './Rows';

/* A measured recall, three decimals. `fmtRecall` is for the bars a family
   declares (0.90, 0.95, 0.99) and prints the raw float for anything else,
   which on a measured 0.9033000000000001 is nine digits of noise. */
function r3(r: number): string {
  return r >= 0.9995 ? '1.000' : r.toFixed(3);
}

function reachText(c: ParticipantCurve): string {
  return c.reach === null ? '—' : r3(c.reach);
}

/** Where a group row is read: its common bar, or `exact`. */
export function groupReading(row: GroupRowModel): string {
  return row.exact ? 'exact' : row.bar === null || row.qualityGap ? 'no common bar' : `@ ${r3(row.bar)}`;
}

export function GroupTableRow({
  row,
  results,
  gridCols,
  metric,
  direction,
  cells,
  lead,
  plotted,
  selected,
  onPlot,
  onCell,
}: {
  row: GroupRowModel;
  results: readonly ResultModel[];
  gridCols: string;
  metric: Metric;
  direction: Direction;
  cells: CellMode;
  /** First of its filter case's block: a firmer rule above it. */
  lead: boolean;
  /** Ticked: its curves are on the graph. */
  plotted: boolean;
  selected: string | null;
  onPlot: (e: MouseEvent<HTMLButtonElement>) => void;
  onCell: (pid: string) => void;
}): ReactNode {
  // The label is the title: the key (`eq-10/10`) says the same, and the bar
  // the row is read at is the graph's line (and this label's title). What a
  // label still says beside the title is what no bar can: an exact row, or a
  // group with no bar every participant can be read at.
  const reading = groupReading(row);
  const tail = row.exact ? 'exact' : row.bar === null || row.qualityGap ? 'no common bar' : null;

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
    <div className={'trow' + (lead ? ' lead' : '')} style={{ gridTemplateColumns: gridCols }}>
      <button
        type="button"
        role="checkbox"
        aria-checked={plotted}
        className={'rowlab pick' + (plotted ? ' on' : '')}
        data-act="row"
        data-id={row.key}
        title={`${rowTitle(row)} ${reading}\n${barNote}\n${PICK_TITLE}`}
        onClick={onPlot}
      >
        <span className="ck" aria-hidden="true" />
        {rowTitle(row)}
        {tail && <span className="tg">{tail}</span>}
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
            {!row.qualityGap && (
              <span className="greach" title="highest recall this participant's curve reaches">
                @ {reachText(c)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
