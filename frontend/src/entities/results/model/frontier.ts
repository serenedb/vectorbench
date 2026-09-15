/* Pareto frontier and crossing — docs/contracts.md section 9, implemented
   identically to lib/vectorbench/frontier.py and checked against the same test
   vectors (lib/vectorbench/testdata/frontier_cases.json, tests/frontier.test.mjs).

   Pure: no React, no page state, no imports beyond the contract types, so the
   rule stays readable on its own and node can run it straight from source. */

import type { RawGroup, RawPoint, Recall } from './types.ts';

/** Density rule: the two points bracketing a row's recall may be at most this far apart. */
export const GAP_LIMIT = 0.02;
/** Tolerance on recall comparisons. */
export const EPS = 1e-9;

/** `higher` for qps, `lower` for every latency statistic. */
export type Direction = 'higher' | 'lower';

/** A point reduced to what the rule needs; `index` points back into the group's list. */
export interface Point {
  recall: number;
  value: number;
  knobs: Record<string, unknown>;
  index: number;
}

export type Crossing =
  | { status: 'none' }
  | { status: 'not_reached'; reached: number }
  | { status: 'above'; value: number; point: Point }
  | { status: 'point'; value: number; point: Point }
  | { status: 'bracket_too_wide'; gap: number; a: Point; b: Point }
  | { status: 'interpolated'; value: number; a: Point; b: Point };

/** A crossing, or the group's own failure to have one. */
export type Cell = Crossing | { status: 'unsupported' | 'n/a' | 'error'; reason?: string | null };

export function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** `qps`, or one statistic of `latency_ms`. */
export function metricValue(point: RawPoint, metric: string): unknown {
  if (metric === 'qps') return point.qps;
  const lat = point.latency_ms as unknown as Record<string, unknown> | undefined;
  return lat ? lat[metric] : undefined;
}

/**
 * Step 1: keep points with a numeric recall and a numeric, positive value
 * (positive because the interpolation is in log space). `valueOf` picks the
 * metric; the shared test vectors carry a plain `value`.
 */
export function toPoints<P extends { recall?: unknown; knobs?: unknown }>(
  points: readonly P[],
  valueOf: (p: P) => unknown,
): Point[] {
  const out: Point[] = [];
  points.forEach((p, i) => {
    const r = p.recall;
    const v = valueOf(p);
    if (isNumber(r) && isNumber(v) && v > 0) {
      out.push({
        recall: r,
        value: v,
        knobs: { ...((p.knobs as Record<string, unknown> | null | undefined) ?? {}) },
        index: i,
      });
    }
  });
  return out;
}

export function usablePoints(points: readonly RawPoint[], metric: string): Point[] {
  return toPoints(points, (p) => metricValue(p, metric));
}

/**
 * Step 2: sort by recall descending, then by metric best-first; sweep, keeping a
 * point only if its metric is strictly better than every kept point (which all
 * have higher or equal recall). Returned re-sorted by recall ascending.
 */
export function frontier(points: readonly Point[], direction: Direction): Point[] {
  const better =
    direction === 'higher' ? (a: number, b: number) => a > b : (a: number, b: number) => a < b;
  const ordered = [...points].sort(
    (p, q) => q.recall - p.recall || (direction === 'higher' ? q.value - p.value : p.value - q.value),
  );
  const kept: Point[] = [];
  let best: number | null = null;
  for (const p of ordered) {
    if (best === null || better(p.value, best)) {
      kept.push(p);
      best = p.value;
    }
  }
  kept.sort((p, q) => p.recall - q.recall);
  return kept;
}

/** Points of `points` that `frontier` dropped: another point has both higher recall and a better metric. */
export function dominated(points: readonly Point[], direction: Direction): Point[] {
  const front = new Set(frontier(points, direction));
  return points.filter((p) => !front.has(p));
}

function isIntegerValue(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Step 7: both points have exactly one knob, the same one, integer valued, differing by 1. */
export function adjacentInt(a: Point, b: Point): boolean {
  const ka = Object.keys(a.knobs);
  const kb = Object.keys(b.knobs);
  if (ka.length !== 1 || kb.length !== 1 || ka[0] !== kb[0]) return false;
  const va = a.knobs[ka[0]];
  const vb = b.knobs[kb[0]];
  if (!isIntegerValue(va) || !isIntegerValue(vb)) return false;
  return Math.abs(va - vb) === 1;
}

/** a: the point with the largest recall <= r; b: the smallest recall >= r (points sorted by recall). */
function bracket(sorted: readonly Point[], r: number): [Point, Point] {
  let a = sorted[0];
  for (const p of sorted) if (p.recall <= r + EPS && p.recall > a.recall) a = p;
  let b = sorted[sorted.length - 1];
  for (const p of sorted) if (p.recall >= r - EPS && p.recall < b.recall) b = p;
  return [a, b];
}

/** Steps 3–8 for a row's recall `r`. */
export function crossing(points: readonly Point[], direction: Direction, r: number): Crossing {
  const front = frontier(points, direction);
  if (!front.length) return { status: 'none' };
  const lo = front[0];
  const hi = front[front.length - 1];
  if (r > hi.recall + EPS) return { status: 'not_reached', reached: hi.recall };
  if (r <= lo.recall + EPS) return { status: 'above', value: lo.value, point: lo };
  // Density is a property of what the participant declared: the two measured points around r,
  // dominated or not, must be close (step 7). The value is then read off the frontier, so a
  // dominated point (slower and worse) never lowers the reading.
  const all = [...points].sort((p, q) => p.recall - q.recall);
  const [da, db] = bracket(all, r);
  if (!(da === db || Math.abs(da.recall - db.recall) <= EPS)) {
    const gap = db.recall - da.recall;
    if (gap > GAP_LIMIT + EPS && !adjacentInt(da, db)) return { status: 'bracket_too_wide', gap, a: da, b: db };
  }
  const [a, b] = bracket(front, r);
  if (a === b || Math.abs(a.recall - b.recall) <= EPS) return { status: 'point', value: a.value, point: a };
  const t = (r - a.recall) / (b.recall - a.recall);
  const value = Math.exp(Math.log(a.value) + t * (Math.log(b.value) - Math.log(a.value)));
  return { status: 'interpolated', value, a, b };
}

const GROUP_STATUSES = new Set(['ok', 'unsupported', 'n/a', 'error']);

/**
 * The cell for a results-file group at the row's recall — `cell()` in
 * frontier.py. A missing group is `unsupported` (contracts section 5); a group
 * that is not `ok` carries its own status; an exact row takes the group's
 * first usable point.
 */
export function cell(group: RawGroup | null | undefined, metric: string, r: Recall): Cell {
  if (!group) return { status: 'unsupported' };
  if (group.status !== 'ok') {
    const status = GROUP_STATUSES.has(group.status) ? group.status : 'error';
    return { status: status as 'unsupported' | 'n/a' | 'error', reason: group.reason ?? null };
  }
  const direction: Direction = metric === 'qps' ? 'higher' : 'lower';
  const pts = usablePoints(group.points ?? [], metric);
  if (r === 'exact') {
    if (!pts.length) return { status: 'none' };
    const p = pts[0];
    return { status: 'point', value: p.value, point: p };
  }
  return crossing(pts, direction, r);
}

/** The number a cell shows, or null when it failed. `ok` = point, interpolated, above. */
export function cellValue(c: Cell): number | null {
  return c.status === 'point' || c.status === 'interpolated' || c.status === 'above' ? c.value : null;
}
