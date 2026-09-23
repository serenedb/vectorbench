/* The results grid: header, three sections, the legend — and, under the query
   row that is open, the inline graph. One `grid-template-columns` is shared by
   the header and every row so the columns line up; the label column is wide
   enough for "V11 · eq-10 · k=10 · recall 0.95". */

import { Fragment, useMemo, type Dispatch, type ReactNode } from 'react';
import type { DatasetModel, Grid, QueryRow, ResultModel, Section, SectionScores } from '../../entities/results';
import { groupRows } from '../../entities/results';
import { fmtInt } from '../../shared/lib/format';
import { VIEW_LABELS, type BenchAction, type BenchState } from '../../shared/model';
import { Panel } from '../../shared/ui';
import { CoverageRow, HeaderRow, QueryTableRow, ScoreRow } from './Rows';
import { GroupTableRow } from './GroupRow';
import { TableHead } from './TableHead';
import { TableLegend } from './TableLegend';
import { tableRows } from './model/tableRows';

export interface ResultsTableProps {
  dataset: DatasetModel;
  /** Participants in column order. */
  results: readonly ResultModel[];
  /** Rows the chips left visible, family order. */
  rows: readonly QueryRow[];
  grid: Grid;
  scores: Record<Section, SectionScores>;
  state: BenchState;
  dispatch: Dispatch<BenchAction>;
}

function colW(r: ResultModel): number {
  return Math.min(200, Math.max(112, Math.round(r.name.length * 6.8) + 56));
}

export function ResultsTable({ dataset, results, rows, grid, scores, state, dispatch }: ResultsTableProps): ReactNode {
  const gridCols = '262px ' + results.map((r) => colW(r) + 'px').join(' ');
  const specs = useMemo(() => tableRows(dataset, rows), [dataset, rows]);
  // The chips select query rows; a group is visible when any of its rows is.
  const visibleKeys = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  const gRows = useMemo(
    () => (state.rowMode === 'groups' ? groupRows(dataset, grid.view, grid.metric, grid.direction).filter((g) => visibleKeys.has(g.key)) : []),
    [dataset, grid.view, grid.metric, grid.direction, state.rowMode, visibleKeys],
  );
  const gBySection = useMemo(() => {
    const m = new Map<Section, typeof gRows>();
    for (const g of gRows) m.set(g.section, [...(m.get(g.section) ?? []), g]);
    return m;
  }, [gRows]);
  const total = dataset.queries.length;
  const meta = `${dataset.id} · ${results.length} participants · ${rows.length === total ? total + ' rows' : rows.length + ' of ' + total + ' rows'} · ${VIEW_LABELS[state.view]} · ${fmtInt(dataset.rows)} vectors`;
  const selectedPid = state.detail?.kind === 'cell' ? state.detail.pid : null;
  const selectedQid = state.detail?.kind === 'cell' ? state.detail.qid : null;

  return (
    <Panel grow style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div className="ph" style={{ padding: '6px 12px' }}>
        <span className="pr">&gt;</span>
        <span className="pt">results</span>
        <span className="note" style={{ marginLeft: 'auto', fontSize: 11 }}>{meta}</span>
      </div>

      <div className="tscroll" id="tscroll">
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
              // In group mode the query rows collapse: the group row is drawn
              // once, under the first of its query rows to appear.
              if (state.rowMode === 'groups') {
                const list = gBySection.get(spec.row.section) ?? [];
                const g = list.find((x) => x.key === spec.row.key);
                if (!g || g.qids[0] !== spec.row.id) return null;
                const gopen = state.openRow === g.key;
                return (
                  <Fragment key={spec.key}>
                    <GroupTableRow
                      row={g}
                      results={results}
                      gridCols={gridCols}
                      metric={grid.metric}
                      direction={grid.direction}
                      cells={state.cells}
                      open={gopen}
                      selected={selectedQid === g.key ? selectedPid : null}
                      onToggle={() => dispatch({ type: 'graph-open', id: g.qids[0] })}
                      onCell={(pid) => dispatch({ type: 'detail', detail: { kind: 'cell', pid, qid: g.qids[0] } })}
                    />
                  </Fragment>
                );
              }
              const open = state.openRow === spec.row.id;
              return (
                <Fragment key={spec.key}>
                  <QueryTableRow
                    spec={spec}
                    results={results}
                    gridCols={gridCols}
                    grid={grid}
                    cells={state.cells}
                    open={open}
                    selected={selectedQid === spec.row.id ? selectedPid : null}
                    onToggle={() => dispatch({ type: 'graph-open', id: spec.row.id })}
                    onCell={(pid) => dispatch({ type: 'detail', detail: { kind: 'cell', pid, qid: spec.row.id } })}
                  />
                </Fragment>
              );
            }
          }
        })}
      </div>

      <TableLegend state={state} metric={grid.metric} />
    </Panel>
  );
}
