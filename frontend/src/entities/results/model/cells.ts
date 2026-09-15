/* From a participant's points to the number in a cell — contracts section 9
   applied to section 11's row → group mapping, plus the grid the page computes
   once per (dataset, view, metric) so the table, the scores and the graph read
   the same crossings. */

import { LATENCY_METRICS, isLatencyMetric, type LatencyMetric } from '../../../shared/model/state.ts';
import { cell, cellValue, type Cell, type Direction } from './frontier.ts';
import type { DatasetModel, QueryRow, ResultModel } from './model.ts';
import type { RawGroup, View } from './types.ts';

export { LATENCY_METRICS, isLatencyMetric, type LatencyMetric };

/** The graph's y axis and the cell's number: qps in the throughput view, a latency statistic otherwise. */
export type Metric = 'qps' | LatencyMetric;

export function metricFor(view: View, latencyMetric: LatencyMetric): Metric {
  return view === 'throughput' ? 'qps' : latencyMetric;
}

export function directionOf(metric: Metric): Direction {
  return metric === 'qps' ? 'higher' : 'lower';
}

/** The participant's group behind a row in a view; undefined = unsupported (missing from the file). */
export function groupFor(result: ResultModel, row: QueryRow, view: View): RawGroup | undefined {
  return result.groups.get(view + '|' + row.key);
}

export function cellFor(result: ResultModel, row: QueryRow, view: View, metric: Metric): Cell {
  return cell(groupFor(result, row, view), metric, row.recall);
}

export function isOk(c: Cell): boolean {
  return cellValue(c) !== null;
}

/** The grey cell's text — the page vocabulary of contracts section 9. */
export function failLabel(c: Cell): string {
  switch (c.status) {
    case 'not_reached':
      return 'reached ' + c.reached.toFixed(2);
    case 'bracket_too_wide':
      return 'bracket too wide';
    case 'none':
      return 'no points';
    case 'unsupported':
    case 'n/a':
    case 'error':
      return c.status;
    default:
      return 'ok';
  }
}

/** One line for the detail: how the number was read off the curve. */
export function statusLabel(c: Cell): string {
  switch (c.status) {
    case 'point':
      return 'ok · a measured point at the row recall';
    case 'interpolated':
      return 'ok · interpolated log-linearly between the two bracketing points';
    case 'above':
      return 'ok · every point is above the row recall; the lowest-recall point is taken';
    case 'not_reached':
      return `failed · the curve reaches recall ${c.reached.toFixed(4)} at most`;
    case 'bracket_too_wide':
      return `failed · the bracketing points are ${c.gap.toFixed(4)} recall apart (limit 0.02, or adjacent integer knob values)`;
    case 'none':
      return 'failed · the group has no usable point';
    default:
      return `failed · ${c.status}${c.reason ? ': ' + c.reason : ''}`;
  }
}

export interface Grid {
  view: View;
  metric: Metric;
  direction: Direction;
  /** `gridKey(qid, pid)` → cell, for every row of the family and every participant of the dataset. */
  cells: ReadonlyMap<string, Cell>;
  /** qid → the best ok value in the row over every participant, or null when no one is ok. */
  best: ReadonlyMap<string, number | null>;
}

export function gridKey(qid: string, pid: string): string {
  return qid + '|' + pid;
}

export function computeGrid(dataset: DatasetModel, view: View, metric: Metric): Grid {
  const direction = directionOf(metric);
  const cells = new Map<string, Cell>();
  const best = new Map<string, number | null>();
  for (const row of dataset.family.queries) {
    let b: number | null = null;
    for (const r of dataset.results) {
      const c = cellFor(r, row, view, metric);
      cells.set(gridKey(row.id, r.id), c);
      const v = cellValue(c);
      if (v !== null) b = b === null ? v : direction === 'higher' ? Math.max(b, v) : Math.min(b, v);
    }
    best.set(row.id, b);
  }
  return { view, metric, direction, cells, best };
}

export function gridCell(grid: Grid, qid: string, pid: string): Cell {
  return grid.cells.get(gridKey(qid, pid)) ?? { status: 'unsupported' };
}
