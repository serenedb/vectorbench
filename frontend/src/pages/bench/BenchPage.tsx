/* The page: one window — the title bar, the toolbar, the table and the graph
   side by side, the status bar — and whichever detail is open over it.

   The table is the list the graph draws from: a ticked row is a drawn one, so
   choosing rows, comparing them and reading their numbers happen in one place
   and the curves answer beside it. The dataset, the view and the latency
   statistic sit in the toolbar; the rest of what was a sidebar — the chips,
   the participants, the row reading, the cell format — waits in its menus. A
   cell or a GENERAL row opens its detail as a modal, which shows more than a
   strip would hold.

   Everything under the toolbar is a pure function of `state` and the
   benchmark: the grid is computed once per (dataset, view, metric), the scores
   once per grid and visible rows, and the column order from the section the
   reader picked — all of it over the participants on screen. */

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
  type DatasetModel,
  type Metric,
  type Section,
  type SectionScores,
} from '../../entities/results';
import { useBenchShortcuts, useBenchState, type BenchEnv, type BenchState } from '../../shared/model';
import { Panel, SplitPane } from '../../shared/ui';
import { GraphPane } from '../../widgets/curve-graph/GraphPane';
import { CellDetailModal } from '../../widgets/detail/CellDetailModal';
import { HeaderDetailModal } from '../../widgets/detail/HeaderDetailModal';
import { BenchHeader } from '../../widgets/header/BenchHeader';
import { ResultsTable, tableWidth } from '../../widgets/results-table';
import { StatusBar } from '../../widgets/status-bar/StatusBar';
import { Toolbar } from '../../widgets/toolbar/Toolbar';
import { readingSize, screenRows, tickedRows } from './model/selection';

const EMPTY_TAGS: ReadonlySet<string> = new Set();

type TableInputs = Pick<BenchState, 'view' | 'rowMode' | 'chips' | 'sortSection'>;

/** What the table draws for one set of participants: the grid, the rows the
    chips leave, the group rows they leave, both sections' scores and the
    column order they give. */
function tableModel(dataset: DatasetModel, metric: Metric, { view, rowMode, chips, sortSection }: TableInputs) {
  const grid = computeGrid(dataset, view, metric);
  const rows = visibleRows(dataset.queries, chips);
  // In group mode the score and coverage rows have to describe the rows the
  // table is actually drawing, or the page ranks its columns by a grid the
  // reader cannot see.
  const visibleKeys = new Set(rows.map((r) => r.key));
  const gRows = rowMode === 'groups' ? groupRows(dataset, grid.view, grid.metric, grid.direction).filter((g) => visibleKeys.has(g.key)) : [];
  const scores: Record<Section, SectionScores> =
    rowMode === 'groups'
      ? {
          nofilter: sectionScoresByGroup(gRows, dataset.results, grid.direction, 'nofilter'),
          filtered: sectionScoresByGroup(gRows, dataset.results, grid.direction, 'filtered'),
        }
      : {
          nofilter: sectionScores(grid, dataset.results, rows.filter((r) => r.section === 'nofilter'), 'nofilter'),
          filtered: sectionScores(grid, dataset.results, rows.filter((r) => r.section === 'filtered'), 'filtered'),
        };
  return { grid, rows, gRows, scores, results: orderResults(dataset.results, scores[sortSection]) };
}

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
      // Either reading's ids: a link may tick query rows or groups.
      rowsFor: (id) => new Set(datasetById(id)?.queries.flatMap((q) => [q.id, q.key]) ?? []),
      participants: BENCH?.participants.map((p) => p.id) ?? [],
    }),
    [],
  );
  const [state, dispatch] = useBenchState(env);
  useBenchShortcuts(state, dispatch);

  const dataset = datasetById(state.dataset ?? BENCH?.defaultDataset);
  const metric = metricFor(state.view, state.latencyMetric);
  const { view, rowMode, chips, sortSection, hidden } = state;
  // Switching a participant off takes it out of the comparison, not only out
  // of view — searchbench's rule, where every ratio is to the fastest engine
  // on screen. Each row's best, each group's common recall bar, the scores,
  // the coverage and the column order are all computed over `shown`.
  const shown = useMemo(
    () => (dataset && hidden.size ? { ...dataset, results: dataset.results.filter((r) => !hidden.has(r.id)) } : dataset),
    [dataset, hidden],
  );
  const model = useMemo(
    () => (shown ? tableModel(shown, metric, { view, rowMode, chips, sortSection }) : null),
    [shown, metric, view, rowMode, chips, sortSection],
  );
  // The participant list keeps the order the columns would have with nobody
  // hidden, so a click never reshuffles it under the pointer.
  const everyone = useMemo(
    () => (!dataset || !model ? [] : shown === dataset ? model.results : tableModel(dataset, metric, { view, rowMode, chips, sortSection }).results),
    [dataset, shown, model, metric, view, rowMode, chips, sortSection],
  );
  const onScreen = useMemo(() => (model ? screenRows(model.rows, rowMode) : []), [model, rowMode]);
  const ticked = useMemo(() => (dataset ? tickedRows(state.graphRows, rowMode, dataset, onScreen) : []), [state.graphRows, rowMode, dataset, onScreen]);
  const plotted = useMemo(() => ticked.filter((id) => onScreen.includes(id)), [ticked, onScreen]);

  if (!BENCH || !dataset || !shown || !model) {
    return (
      <div className="vb-app">
        <Panel grow className="vb-window">
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
        </Panel>
      </div>
    );
  }

  const { grid, rows, gRows, scores, results } = model;
  const detail = state.detail;
  const detailResult = detail?.kind === 'cell' ? dataset.results.find((r) => r.id === detail.pid) : undefined;
  const detailRow = detail?.kind === 'cell' ? dataset.queries.find((q) => q.id === detail.qid) : undefined;

  return (
    <div className="vb-app">
      <Panel grow className="vb-window">
        <BenchHeader />
        <Toolbar bench={BENCH} dataset={dataset} everyone={everyone} state={state} dispatch={dispatch} />
        {BENCH.sample && (
          <div className="banner" data-role="sample-banner">
            <b>synthetic sample</b>
            <span>
              Every number on this page was generated by <code>frontend/scripts/sample-results.mjs</code> to exercise the page; nothing was measured.{' '}
              <code>vectorbench assemble</code> replaces <code>results.json</code> with real results.
            </span>
          </div>
        )}
        {/* Until the reader drags the rule, the table takes what its columns
            want and the graph the rest, but never less than 38% of the width. */}
        <SplitPane
          storageKey="vb-split"
          defaultLeft={`min(${tableWidth(results)}px, 62%)`}
          minLeft={380}
          minRight={340}
          left={
            <ResultsTable
              dataset={shown}
              results={results}
              rows={rows}
              groups={gRows}
              grid={grid}
              scores={scores}
              state={state}
              onScreen={onScreen}
              ticked={ticked}
              dispatch={dispatch}
            />
          }
          right={
            <GraphPane
              dataset={shown}
              results={results}
              grid={grid}
              mode={rowMode}
              groups={gRows}
              plotted={plotted}
              ticked={ticked.length}
              onClear={() => dispatch({ type: 'plot', ids: [] })}
            />
          }
        />
        <StatusBar
          dataset={dataset}
          shown={shown.results.length}
          participants={dataset.results.length}
          rows={onScreen.length}
          total={readingSize(dataset, rowMode)}
          state={state}
        />
      </Panel>
      {detail?.kind === 'header' && <HeaderDetailModal dataset={shown} results={results} row={detail.row} dispatch={dispatch} />}
      {detail?.kind === 'cell' && detailResult && detailRow && (
        <CellDetailModal dataset={dataset} result={detailResult} row={detailRow} state={state} dispatch={dispatch} />
      )}
    </div>
  );
}
