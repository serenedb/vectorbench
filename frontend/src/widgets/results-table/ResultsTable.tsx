/* The results grid, the left pane of the window: header, the three sections,
   and on every query row (group row, in the group reading) a checkbox — the
   table is the list the graph beside it draws from. One `grid-template-columns`
   is shared by the header and every row so the columns line up; the label
   column is wide enough for "V11 · eq-10 · k=10 · recall 0.95".

   It answers the keyboard like a list: ↑ ↓ walk the row labels, Space ticks
   the one with focus (or opens its detail, or sorts by it). With the pointer, a
   click ticks one row, a double-click draws that row alone, and a shift-click
   ticks every row from the last one clicked. */

import { useMemo, useRef, type Dispatch, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { DatasetModel, Grid, GroupRowModel, QueryRow, ResultModel, Section, SectionScores } from '../../entities/results';
import type { BenchAction, BenchState } from '../../shared/model';
import { CoverageRow, HeaderRow, QueryTableRow, ScoreRow } from './Rows';
import { GroupTableRow } from './GroupRow';
import { TableHead } from './TableHead';
import { tableRows } from './model/tableRows';

export interface ResultsTableProps {
  /** The dataset with only the participants on screen. */
  dataset: DatasetModel;
  /** Participants in column order. */
  results: readonly ResultModel[];
  /** Rows the chips left visible, family order. */
  rows: readonly QueryRow[];
  /** The group rows on screen, for the group reading. */
  groups: readonly GroupRowModel[];
  grid: Grid;
  scores: Record<Section, SectionScores>;
  state: BenchState;
  /** Row ids the table lists in the reading on screen, in its order. */
  onScreen: readonly string[];
  /** Every ticked id in the reading on screen, the ones the chips hide included. */
  ticked: readonly string[];
  dispatch: Dispatch<BenchAction>;
}

/* Narrow on purpose, so the graph beside the table gets the width. A label is
   its title and its reading (`eq-10 · k=10  @ 0.950`); a column is as wide as
   the longest word of its participant's name, which wraps onto a second line
   — a cell's number and reach need less than that. */
const LABEL_W = 206;

function colW(r: ResultModel): number {
  const word = Math.max(...r.name.split(/\s+/).map((w) => w.length));
  return Math.min(140, Math.max(94, Math.round(word * 6.9) + 30));
}

/** The width the grid wants, its scrollbar included: the split's default for the table. */
export function tableWidth(results: readonly ResultModel[]): number {
  return LABEL_W + results.reduce((w, r) => w + colW(r), 0) + 12;
}

export function ResultsTable({ dataset, results, rows, groups, grid, scores, state, onScreen, ticked, dispatch }: ResultsTableProps): ReactNode {
  const gridCols = `${LABEL_W}px ` + results.map((r) => colW(r) + 'px').join(' ');
  const specs = useMemo(() => tableRows(dataset, rows), [dataset, rows]);
  // A group row is drawn where the first of its query rows the chips leave
  // would be: a chip can hide the group's first bar and keep another.
  const groupAt = useMemo(() => {
    const at = new Map<string, GroupRowModel>();
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      const g = groups.find((x) => x.key === r.key);
      if (g) at.set(r.id, g);
    }
    return at;
  }, [rows, groups]);
  /* The table lists a section's rows in blocks, one per filter case
     (tableOrder), each under a firmer rule: the ids that start one. */
  const leads = useMemo(() => {
    const out = new Set<string>();
    let block: string | null = null;
    for (const spec of specs) {
      if (spec.kind !== 'query') continue;
      if (state.rowMode === 'groups' && !groupAt.has(spec.row.id)) continue;
      const here = spec.row.section + '|' + spec.row.filter;
      if (here !== block) out.add(spec.row.id);
      block = here;
    }
    return out;
  }, [specs, groupAt, state.rowMode]);
  const tickedSet = useMemo(() => new Set(ticked), [ticked]);
  const selectedPid = state.detail?.kind === 'cell' ? state.detail.pid : null;
  const selectedQid = state.detail?.kind === 'cell' ? state.detail.qid : null;

  const anchor = useRef<string | null>(null);
  const plot = (id: string, e: MouseEvent<HTMLButtonElement>) => {
    let next: string[];
    // `detail` counts the clicks in a row: the second of a double-click
    // leaves this row alone on the graph, whatever the first one did.
    if (e.altKey || e.detail >= 2) {
      next = [id];
    } else if (e.shiftKey && anchor.current !== null && anchor.current !== id && onScreen.includes(anchor.current)) {
      const a = onScreen.indexOf(anchor.current);
      const b = onScreen.indexOf(id);
      const range = onScreen.slice(Math.min(a, b), Math.max(a, b) + 1);
      next = [...ticked, ...range.filter((r) => !tickedSet.has(r))];
    } else {
      next = tickedSet.has(id) ? ticked.filter((r) => r !== id) : [...ticked, id];
    }
    anchor.current = id;
    dispatch({ type: 'plot', ids: next });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const from = (e.target as HTMLElement).closest<HTMLElement>('.rowlab');
    if (!from) return;
    const labels = [...e.currentTarget.querySelectorAll<HTMLElement>('.rowlab')];
    const to = labels[labels.indexOf(from) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!to) return;
    e.preventDefault();
    to.focus({ preventScroll: true });
    // The row, not its label: the label is sticky, and the browser places a
    // sticky element by where it sticks rather than where it sits.
    to.closest('.trow')?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <section className="tablepane" data-role="table" aria-label="results">
      <div className="tscroll" id="tscroll" onKeyDown={onKeyDown}>
        <TableHead results={results} gridCols={gridCols} />
        {specs.map((spec) => {
          switch (spec.kind) {
            case 'section':
              return (
                <div key={spec.key} className="section">
                  <span>
                    <b>{spec.title}</b>
                    {spec.note}
                  </span>
                </div>
              );
            case 'header':
              return <HeaderRow key={spec.key} spec={spec} results={results} gridCols={gridCols} onDetail={(detail) => dispatch({ type: 'detail', detail })} />;
            case 'score':
              return <ScoreRow key={spec.key} spec={spec} results={results} gridCols={gridCols} scores={scores[spec.section]} sorted={state.sortSection === spec.section} onSort={() => dispatch({ type: 'sort', section: spec.section })} />;
            case 'coverage':
              return <CoverageRow key={spec.key} spec={spec} results={results} gridCols={gridCols} scores={scores[spec.section]} sorted={state.sortSection === spec.section} onSort={() => dispatch({ type: 'sort', section: spec.section })} />;
            case 'query': {
              // In the group reading the query rows fold into their group's row.
              if (state.rowMode === 'groups') {
                const g = groupAt.get(spec.row.id);
                if (!g) return null;
                return (
                  <GroupTableRow
                    key={spec.key}
                    row={g}
                    results={results}
                    gridCols={gridCols}
                    metric={grid.metric}
                    direction={grid.direction}
                    cells={state.cells}
                    lead={leads.has(spec.row.id)}
                    plotted={tickedSet.has(g.key)}
                    selected={selectedQid !== null && g.qids.includes(selectedQid) ? selectedPid : null}
                    onPlot={(e) => plot(g.key, e)}
                    onCell={(pid) => dispatch({ type: 'detail', detail: { kind: 'cell', pid, qid: g.qids[0] } })}
                  />
                );
              }
              return (
                <QueryTableRow
                  key={spec.key}
                  spec={spec}
                  results={results}
                  gridCols={gridCols}
                  grid={grid}
                  cells={state.cells}
                  lead={leads.has(spec.row.id)}
                  plotted={tickedSet.has(spec.row.id)}
                  selected={selectedQid === spec.row.id ? selectedPid : null}
                  onPlot={(e) => plot(spec.row.id, e)}
                  onCell={(pid) => dispatch({ type: 'detail', detail: { kind: 'cell', pid, qid: spec.row.id } })}
                />
              );
            }
          }
        })}
      </div>
    </section>
  );
}
