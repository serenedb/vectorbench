/* The results grid: header, three sections, the legend — and, under the query
   row that is open, the inline graph. One `grid-template-columns` is shared by
   the header and every row so the columns line up; the label column is wide
   enough for "V11 · eq-10 · k=10 · recall 0.95". */

import { Fragment, useMemo, type Dispatch, type ReactNode } from 'react';
import type { DatasetModel, Grid, QueryRow, ResultModel, Section, SectionScores } from '../../entities/results';
import { fmtInt } from '../../shared/lib/format';
import { VIEW_LABELS, type BenchAction, type BenchState } from '../../shared/model';
import { Panel } from '../../shared/ui';
import { InlineGraph } from '../curve-graph/InlineGraph';
import { CoverageRow, HeaderRow, QueryTableRow, ScoreRow } from './Rows';
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
  const total = dataset.family.queries.length;
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
                    onToggle={() => dispatch({ type: 'row', id: spec.row.id })}
                    onCell={(pid) => dispatch({ type: 'detail', detail: { kind: 'cell', pid, qid: spec.row.id } })}
                  />
                  {open && <InlineGraph results={results} row={spec.row} grid={grid} dispatch={dispatch} />}
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
