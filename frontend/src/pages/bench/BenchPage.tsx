/* The page frame — searchbench's: the header, the synthetic-data banner when
   the file says so, then two columns, the sidebar (dataset, config, query
   chips, participants) and the table, and whichever modal is open. ⛶ max in
   the table's head drops the sidebar. There is no query panel under the
   table: a cell, a row label and a GENERAL row each open their detail as a
   modal, which shows more than a strip would hold.

   Everything right of the sidebar is a pure function of `state` and the
   benchmark: the grid is computed once per (dataset, view, metric), the scores
   once per grid and visible rows, and the column order from the section the
   reader picked. */

import { useMemo } from 'react';
import {
  BENCH,
  BENCH_ERROR,
  allChipTags,
  computeGrid,
  datasetById,
  metricFor,
  orderResults,
  groupRows,
  sectionScores,
  sectionScoresByGroup,
  visibleRows,
  type Grid,
  type Section,
  type SectionScores,
} from '../../entities/results';
import { useBenchShortcuts, useBenchState, type BenchEnv } from '../../shared/model';
import { ConfigPanel } from '../../widgets/config-panel/ConfigPanel';
import { FullGraphModal } from '../../widgets/curve-graph/FullGraphModal';
import { DatasetPanel } from '../../widgets/dataset-panel/DatasetPanel';
import { CellDetailModal } from '../../widgets/detail/CellDetailModal';
import { HeaderDetailModal } from '../../widgets/detail/HeaderDetailModal';
import { BenchHeader } from '../../widgets/header/BenchHeader';
import { ParticipantsPanel } from '../../widgets/participants-panel/ParticipantsPanel';
import { QueriesPanel } from '../../widgets/queries-panel/QueriesPanel';
import { ResultsTable } from '../../widgets/results-table';

const EMPTY_TAGS: ReadonlySet<string> = new Set();

export function BenchPage() {
  // Stable for the lifetime of the page: results.json is a build input.
  const env = useMemo<BenchEnv>(
    () => ({
      datasets: BENCH?.datasets.map((d) => d.id) ?? [],
      defaultDataset: BENCH?.defaultDataset ?? null,
      tagsFor: (id) => {
        const d = datasetById(id);
        return d ? allChipTags(d) : EMPTY_TAGS;
      },
      rowsFor: (id) => new Set(datasetById(id)?.queries.map((q) => q.id) ?? []),
    }),
    [],
  );
  const [state, dispatch] = useBenchState(env);
  useBenchShortcuts(state, dispatch);

  const dataset = datasetById(state.dataset ?? BENCH?.defaultDataset);
  const metric = metricFor(state.view, state.latencyMetric);
  const grid: Grid | null = useMemo(() => (dataset ? computeGrid(dataset, state.view, metric) : null), [dataset, state.view, metric]);
  const rows = useMemo(() => (dataset ? visibleRows(dataset.queries, state.chips) : []), [dataset, state.chips]);
  // In group mode the score and coverage rows have to describe the rows the
  // table is actually drawing, or the page ranks its columns by a grid the
  // reader cannot see.
  const visibleKeys = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  const gRows = useMemo(
    () => (dataset && grid && state.rowMode === 'groups' ? groupRows(dataset, grid.view, grid.metric, grid.direction).filter((g) => visibleKeys.has(g.key)) : []),
    [dataset, grid, state.rowMode, visibleKeys],
  );
  const scores = useMemo<Record<Section, SectionScores> | null>(() => {
    if (!dataset || !grid) return null;
    if (state.rowMode === 'groups') {
      return {
        nofilter: sectionScoresByGroup(gRows, dataset.results, grid.direction, 'nofilter'),
        filtered: sectionScoresByGroup(gRows, dataset.results, grid.direction, 'filtered'),
      };
    }
    return {
      nofilter: sectionScores(grid, dataset.results, rows.filter((r) => r.section === 'nofilter'), 'nofilter'),
      filtered: sectionScores(grid, dataset.results, rows.filter((r) => r.section === 'filtered'), 'filtered'),
    };
  }, [dataset, grid, rows, gRows, state.rowMode]);
  const results = useMemo(() => (dataset && scores ? orderResults(dataset.results, scores[state.sortSection]) : []), [dataset, scores, state.sortSection]);

  if (!BENCH || !dataset || !grid || !scores) {
    return (
      <div className="vb-app">
        <BenchHeader />
        <div className="err">
          {BENCH_ERROR ? (
            <>
              <div>The results file could not be read.</div>
              <code>{BENCH_ERROR.message}</code>
            </>
          ) : (
            <div>
              No results yet. Run a participant, then <code>vectorbench assemble</code> and <code>npm run build</code> in <code>frontend/</code>.
            </div>
          )}
        </div>
      </div>
    );
  }

  const detail = state.detail;
  const detailResult = detail?.kind === 'cell' ? dataset.results.find((r) => r.id === detail.pid) : undefined;
  const detailRow = detail?.kind === 'cell' ? dataset.queries.find((q) => q.id === detail.qid) : undefined;

  return (
    <div className="vb-app">
      <BenchHeader />
      {BENCH.sample && (
        <div className="banner" data-role="sample-banner">
          <b>synthetic sample</b>
          <span>
            Every number on this page was generated by <code>frontend/scripts/sample-results.mjs</code> to exercise the page; nothing was measured.{' '}
            <code>vectorbench assemble</code> replaces <code>results.json</code> with real results.
          </span>
        </div>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: state.max ? '1fr' : '300px 1fr',
          columnGap: 14,
          flex: 1,
          minHeight: 0,
        }}
      >
        {!state.max && (
          <aside
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 11,
              minHeight: 0,
              minWidth: 0,
              // A short window squeezes the participant list first (it grows
              // into whatever is left); past that the column scrolls rather
              // than cutting off the panels at the bottom of the page.
              overflowY: 'auto',
            }}
          >
            <DatasetPanel bench={BENCH} dataset={dataset} dispatch={dispatch} />
            <ConfigPanel state={state} dispatch={dispatch} />
            <QueriesPanel dataset={dataset} state={state} dispatch={dispatch} />
            <ParticipantsPanel dataset={dataset} results={results} />
          </aside>
        )}

        <main style={{ display: 'flex', flexDirection: 'column', gap: 11, minWidth: 0, minHeight: 0 }}>
          <ResultsTable dataset={dataset} results={results} rows={rows} grid={grid} scores={scores} state={state} dispatch={dispatch} />
        </main>
      </div>
      {state.graphRows && <FullGraphModal dataset={dataset} results={results} grid={grid} state={state} dispatch={dispatch} />}
      {detail?.kind === 'header' && <HeaderDetailModal dataset={dataset} results={results} row={detail.row} dispatch={dispatch} />}
      {detail?.kind === 'cell' && detailResult && detailRow && (
        <CellDetailModal dataset={dataset} result={detailResult} row={detailRow} state={state} dispatch={dispatch} />
      )}
    </div>
  );
}
