/* The one state object the page renders from, and the page's vocabulary
   (DESIGN.md section 2). Shaped after searchbench/frontend/src/shared/model/state.ts:
   readonly by convention — the reducer replaces Sets and arrays rather than
   mutating them — and free of the theme, which the platform's ThemeProvider
   owns (the URL codec still carries a `th` slot for links that pin one).

   This module has no imports so that entities/results can read the vocabulary
   without an upward dependency and node can run it straight from source. */

/** The load condition: Throughput (32 clients) or Latency (1 client). */
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

/** The section whose coverage and score order the columns. */
export type SortSection = 'nofilter' | 'filtered';

/** The rows whose header click opens a detail rather than a graph. */
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
  /** Active chip tags: `filter:eq`, `k:10`, `recall:0.95`, `recall:exact`. */
  chips: ReadonlySet<string>;
  sortSection: SortSection;
  /** The query row whose inline graph is open. */
  openRow: string | null;
  /** Rows drawn in the full-screen graph; null = closed. */
  graphRows: readonly string[] | null;
  /** Never encoded in the URL: a link cannot open a modal. */
  detail: Detail | null;
}

export const INITIAL_STATE: BenchState = {
  dataset: null,
  view: 'throughput',
  latencyMetric: 'p50',
  cells: 'relative',
  chips: new Set(),
  sortSection: 'nofilter',
  openRow: null,
  graphRows: null,
  detail: null,
};
