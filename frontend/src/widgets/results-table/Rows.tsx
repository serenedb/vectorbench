/* One grid row each: a header row (GENERAL and the memory rows), the score
   row, the coverage row and a query row. All four share the sticky label
   button on the left and one cell per participant, coloured ClickBench-style
   by the ratio to the row's best; a cell with nothing to colour is grey and
   carries its reason as text.

   The labels say what a click on them does: a header row's carries the arrow
   of a detail that opens, a query row's is the checkbox that draws the row's
   curves beside the table, and score and coverage sort the columns. */

import type { MouseEvent, ReactNode } from 'react';
import {
  cellValue,
  failLabel,
  gridCell,
  ratioTo,
  rowTitle,
  statusLabel,
  type Grid,
  type ResultModel,
  type SectionScores,
} from '../../entities/results';
import { ratioBg } from '../../shared/lib/color';
import { fmtMetric, fmtRatio, fmtRecall, metricUnit } from '../../shared/lib/format';
import type { CellMode, Detail } from '../../shared/model';
import { OpensMark } from '../../shared/ui';
import type { CoverageSpec, HeaderSpec, QuerySpec, ScoreSpec } from './model/tableRows';

interface Common {
  results: readonly ResultModel[];
  gridCols: string;
}

/** What a query or group label answers to, said where the pointer is. */
export const PICK_TITLE = 'tick to draw this row’s curves beside the table · double-click: this row alone · shift-click: every row between';

function Cell({ ratio, text, title, extra, onClick, act, data }: { ratio: number; text: string; title: string; extra?: string; onClick?: () => void; act?: string; data?: Record<string, string> }) {
  const attrs: Record<string, string> = {};
  if (act) attrs['data-act'] = act;
  for (const [k, v] of Object.entries(data ?? {})) attrs['data-' + k] = v;
  return (
    <div className={'cell' + (onClick ? ' q' : '') + (extra ? ' ' + extra : '')} style={{ background: ratioBg(ratio) }} title={title} onClick={onClick} {...attrs}>
      {text}
    </div>
  );
}

function FailCell({ text, title, onClick, act, data }: { text: string; title: string; onClick?: () => void; act?: string; data?: Record<string, string> }) {
  const attrs: Record<string, string> = {};
  if (act) attrs['data-act'] = act;
  for (const [k, v] of Object.entries(data ?? {})) attrs['data-' + k] = v;
  return (
    <div className={'cell fail' + (onClick ? ' q' : '')} title={title} onClick={onClick} {...attrs}>
      {text}
    </div>
  );
}

/* ---- GENERAL rows and the memory rows ------------------------------------- */

export function HeaderRow({ spec, results, gridCols, onDetail }: Common & { spec: HeaderSpec; onDetail: (d: Detail) => void }): ReactNode {
  const values = results.map((r) => spec.get(r));
  const positives = values.filter((v): v is number => v !== null && v > 0);
  const best = positives.length ? Math.min(...positives) : null;
  return (
    <div className="trow" style={{ gridTemplateColumns: gridCols }}>
      <button type="button" className="rowlab" data-act="header" data-key={spec.key} title={spec.title} onClick={() => onDetail({ kind: 'header', row: spec.key })}>
        {spec.label}
        <span className="un">{spec.unit}</span>
        <OpensMark />
      </button>
      {results.map((r, i) => {
        const v = values[i];
        if (v === null || !(v >= 0)) return <FailCell key={r.id} text={spec.missing(r)} title={spec.missing(r) === 'unsupported' ? 'this participant supports no query of the section' : 'not recorded'} />;
        const ratio = best && best > 0 ? v / best : 1;
        return <Cell key={r.id} ratio={ratio} text={spec.fmt(v)} title={`${r.name} · ${spec.fmt(v)} ${spec.unit} · ${fmtRatio(ratio)} of the best`} />;
      })}
    </div>
  );
}

/* ---- score and coverage ---------------------------------------------------- */

export function ScoreRow({ spec, results, gridCols, scores, sorted, onSort }: Common & { spec: ScoreSpec; scores: SectionScores; sorted: boolean; onSort: () => void }): ReactNode {
  const values = results.map((r) => scores.score.get(r.id) ?? null);
  const finite = values.filter((v): v is number => v !== null);
  const best = finite.length ? Math.min(...finite) : null;
  return (
    <div className="trow" style={{ gridTemplateColumns: gridCols }}>
      <button type="button" className={'rowlab' + (sorted ? ' open' : '')} data-act="sort" data-section={spec.section} title="geomean of each participant's ratios to the row's best over the visible rows it answers · click to order the columns by this section" onClick={onSort}>
        score
        <span className="tg">geomean</span>
        <span className="mk">{sorted ? '▲' : ''}</span>
      </button>
      {results.map((r, i) => {
        const v = values[i];
        const cov = scores.coverage.get(r.id);
        if (v === null) return <FailCell key={r.id} text="x" title="ok on no visible row of this section" />;
        return <Cell key={r.id} ratio={best ? v / best : 1} text={fmtRatio(v)} title={`${r.name} · geomean ${fmtRatio(v)} over ${cov?.ok ?? 0} ok rows`} />;
      })}
    </div>
  );
}

export function CoverageRow({ spec, results, gridCols, scores, sorted, onSort }: Common & { spec: CoverageSpec; scores: SectionScores; sorted: boolean; onSort: () => void }): ReactNode {
  const oks = results.map((r) => scores.coverage.get(r.id)?.ok ?? 0);
  const max = Math.max(0, ...oks);
  return (
    <div className="trow" style={{ gridTemplateColumns: gridCols }}>
      <button type="button" className={'rowlab' + (sorted ? ' open' : '')} data-act="sort" data-section={spec.section} title="rows with a number over the visible rows of the section · click to order the columns by this section" onClick={onSort}>
        coverage
        <span className="mk">{sorted ? '▲' : ''}</span>
      </button>
      {results.map((r) => {
        const cov = scores.coverage.get(r.id) ?? { ok: 0, total: 0 };
        const text = `${cov.ok}/${cov.total}`;
        if (!cov.ok) return <FailCell key={r.id} text={text} title={`${r.name} · answers none of the visible rows`} />;
        return <Cell key={r.id} ratio={max / cov.ok} text={text} title={`${r.name} · ${cov.ok} of ${cov.total} visible rows have a number`} />;
      })}
    </div>
  );
}

/* ---- a query row ------------------------------------------------------------- */

export function QueryTableRow({
  spec,
  results,
  gridCols,
  grid,
  cells,
  lead,
  plotted,
  selected,
  onPlot,
  onCell,
}: Common & {
  spec: QuerySpec;
  grid: Grid;
  cells: CellMode;
  /** First of its filter case's block: a firmer rule above it. */
  lead: boolean;
  /** Ticked: its curves are on the graph. */
  plotted: boolean;
  /** participant id of the cell whose detail is open, if any. */
  selected: string | null;
  onPlot: (e: MouseEvent<HTMLButtonElement>) => void;
  onCell: (pid: string) => void;
}): ReactNode {
  const row = spec.row;
  const best = grid.best.get(row.id) ?? null;
  // In this reading a row is one recall bar of its group: the bar is what tells
  // V01, V02 and V03 apart, so unlike a group row's label this one prints it.
  const reading = row.exact ? 'exact' : '@ ' + fmtRecall(row.recall);
  const tags = `${rowTitle(row)} ${reading}`;
  return (
    <div className={'trow' + (lead ? ' lead' : '')} style={{ gridTemplateColumns: gridCols }}>
      <button
        type="button"
        role="checkbox"
        aria-checked={plotted}
        className={'rowlab pick' + (plotted ? ' on' : '')}
        data-act="row"
        data-id={row.id}
        title={`${row.id} · ${rowTitle(row)} ${reading}\n${PICK_TITLE}`}
        onClick={onPlot}
      >
        <span className="ck" aria-hidden="true" />
        {row.id}
        <span className="tg">{tags}</span>
      </button>
      {results.map((r) => {
        const c = gridCell(grid, row.id, r.id);
        const v = cellValue(c);
        const data = { id: row.id, pid: r.id };
        if (v === null) {
          return <FailCell key={r.id} text={failLabel(c)} title={`${r.name} · ${row.id} · ${statusLabel(c)} — click for the measurements`} act="cell" data={data} onClick={() => onCell(r.id)} />;
        }
        const ratio = best !== null ? ratioTo(v, best, grid.direction) : 1;
        const text = cells === 'relative' ? fmtRatio(ratio) : fmtMetric(grid.metric, v);
        const title = `${r.name} · ${row.id} · ${fmtMetric(grid.metric, v)} ${metricUnit(grid.metric)} · ${fmtRatio(ratio)} · ${statusLabel(c)} — click for the measurements`;
        return <Cell key={r.id} ratio={ratio} text={text} title={title} extra={selected === r.id ? 'sel' : undefined} act="cell" data={data} onClick={() => onCell(r.id)} />;
      })}
    </div>
  );
}
