/* The one state object the page renders from, and the page's vocabulary
   (DESIGN.md section 2). Shaped after searchbench/frontend/src/shared/model/state.ts:
   readonly by convention — the reducer replaces Sets and arrays rather than
   mutating them — and free of the theme, which the platform's ThemeProvider
   owns (the URL codec still carries a `th` slot for links that pin one).

   This module has no imports so that entities/results can read the vocabulary
   without an upward dependency and node can run it straight from source. */

/** The load condition: Throughput (32 clients) or Latency — a latency run's one client, or, on a
    dataset without one, the throughput run's per-query latencies (entities/results latencyOf). */
export type View = 'throughput' | 'latency';
export const VIEWS: readonly View[] = ['throughput', 'latency'];
export const VIEW_LABELS: Record<View, string> = {
  throughput: 'Throughput · 32 clients · QPS',
  latency: 'Latency · 1 client',
};

/** The latency statistic a cell and the graph read in the Latency view. */
export const LATENCY_METRICS = ['avg', 'min', 'p50', 'p95', 'p99', 'max'] as const;
export type LatencyMetric = (typeof LATENCY_METRICS)[number];

export function isLatencyMetric(x: unknown): x is LatencyMetric {
  return (LATENCY_METRICS as readonly unknown[]).includes(x);
}

/** "x1.00" against the row's best, or the value itself. */
export type CellMode = 'relative' | 'absolute';

/** How the grid is cut into rows.

   `bars` is the published reading: one row per (group, recall bar), each cell
   the metric at that bar. `groups` folds a group's bars into one row and reads
   every participant at the strongest bar all of them reach, so a participant
   whose curve stops short of a declared bar shows its number and its reach
   instead of a word. Both read the same frontier. */
export type RowMode = 'bars' | 'groups';
export const ROW_MODES: readonly RowMode[] = ['bars', 'groups'];
export const ROW_MODE_LABELS: Record<RowMode, string> = {
  bars: 'by recall bar',
  groups: 'by group',
};

/** The section whose coverage and score order the columns. */
export type SortSection = 'nofilter' | 'filtered';

/** The rows whose label opens a detail rather than ticking a curve. */
export type HeaderRowKey = 'load' | 'disk' | 'memload' | 'startup' | 'memq:nofilter' | 'memq:filtered';

export type Detail =
  | { kind: 'cell'; pid: string; qid: string }
  | { kind: 'header'; row: HeaderRowKey };

export interface BenchState {
  /** `<family>-<size>`; null = the benchmark's default dataset. */
  dataset: string | null;
  view: View;
  latencyMetric: LatencyMetric;
  cells: CellMode;
  rowMode: RowMode;
  /** Active chip tags: `filter:eq`, `k:10`, `recall:0.95`, `recall:exact`. */
  chips: ReadonlySet<string>;
  /** Participants switched off, by id. Kept across datasets: an id names the
      same database and index family in every one. */
  hidden: ReadonlySet<string>;
  sortSection: SortSection;
  /** The rows ticked in the table, whose curves the graph beside it draws.
      Query ids in the bar reading, group keys in the group one; either kind is
      read in the reading on screen (a group stands for its bars, a bar for its
      group), so switching the reading keeps what was ticked. null = nothing
      picked yet, which ticks the first row; [] = everything unticked. */
  graphRows: readonly string[] | null;
  /** Never encoded in the URL: a link cannot open a modal. */
  detail: Detail | null;
}

export const INITIAL_STATE: BenchState = {
  dataset: null,
  view: 'throughput',
  latencyMetric: 'p50',
  cells: 'relative',
  rowMode: 'groups',
  chips: new Set(),
  hidden: new Set(),
  sortSection: 'nofilter',
  graphRows: null,
  detail: null,
};
