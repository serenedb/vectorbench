/* One row per group instead of one per (group, recall bar).

   The bar-per-row reading asks every participant for its speed at a recall the
   row names, and writes "reached 0.90" when a participant's curve stops short.
   That is honest but it spends a row on each bar and leaves the reader to
   assemble the curve from several of them, and on a filtered group where one
   engine tops out below every bar it leaves a column of words.

   This reads the same curves a different way: one row per group, every
   participant measured at the strongest bar all of them actually reach, plus
   what each reaches on its own and the stretch of recall where each is fastest.
   Nothing here re-measures; it is the section 9 frontier, summarised. */

import { cellValue, crossing, frontier, usablePoints, type Direction, type Point } from './frontier.ts';
import type { DatasetModel, QueryRow, Section } from './model.ts';
import { groupFor, type Metric } from './cells.ts';
import type { View } from './types.ts';

/** Bars the family declares for a group, strongest first, `exact` dropped. */
function barsOf(rows: readonly QueryRow[]): number[] {
  const out = new Set<number>();
  for (const r of rows) if (!r.exact && typeof r.recall === 'number') out.add(r.recall);
  return [...out].sort((a, b) => b - a);
}

export interface ParticipantCurve {
  pid: string;
  /** Pareto points, recall ascending; empty when the participant has no usable point. */
  front: readonly Point[];
  /** Highest recall the curve reaches, or null when there is no curve. */
  reach: number | null;
  /** The metric at the row's common bar, or null when this participant cannot be read there. */
  value: number | null;
  /** Recall interval over which this participant is the best of the row, or null. */
  lead: readonly [number, number] | null;
}

export interface GroupRowModel {
  key: string;
  section: Section;
  filter: string;
  k: number;
  exact: boolean;
  /** Query ids folded into this row, for the detail view and the chips. */
  qids: readonly string[];
  /** The strongest declared bar every participant reaches, or null when there is none. */
  bar: number | null;
  /** Why that bar: a declared one, or the best common reach when no declared bar is shared. */
  barKind: 'declared' | 'common-reach' | 'exact' | 'none';
  /** The weakest bar the family declares for this group; the floor of a real comparison. */
  floor: number | null;
  /** The common bar is under that floor: the engines differ in what they can answer at
      all, so their speeds are not comparable here and the row reports reach instead. */
  qualityGap: boolean;
  curves: readonly ParticipantCurve[];
  /** Best value over the participants at the bar, or null. */
  best: number | null;
}

const better = (d: Direction) => (a: number, b: number) => (d === 'higher' ? a > b : a < b);

/** Value of a participant's frontier at recall r, or null when the curve stops short of it. */
function valueAt(front: readonly Point[], direction: Direction, r: number): number | null {
  if (!front.length) return null;
  return cellValue(crossing(front as Point[], direction, r));
}

/** Where each participant is on top, sampled over the recall span the row covers.

   A lead is reported as the span between the first and last sample a
   participant wins, so a curve that leads in two places reads as leading
   across both -- the sparkline shows the crossings exactly. */
function leads(curves: ParticipantCurve[], direction: Direction, lo: number, hi: number): void {
  const N = 64;
  const cmp = better(direction);
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  for (let i = 0; i <= N; i++) {
    const r = lo + ((hi - lo) * i) / N;
    let winner: string | null = null;
    let best: number | null = null;
    for (const c of curves) {
      const v = valueAt(c.front, direction, r);
      if (v === null) continue;
      if (best === null || cmp(v, best)) {
        best = v;
        winner = c.pid;
      }
    }
    if (winner === null) continue;
    if (!first.has(winner)) first.set(winner, r);
    last.set(winner, r);
  }
  for (const c of curves) {
    const a = first.get(c.pid);
    const b = last.get(c.pid);
    (c as { lead: readonly [number, number] | null }).lead = a === undefined || b === undefined ? null : [a, b];
  }
}

export function groupRows(dataset: DatasetModel, view: View, metric: Metric, direction: Direction): GroupRowModel[] {
  const byGroup = new Map<string, QueryRow[]>();
  for (const q of dataset.queries) {
    const list = byGroup.get(q.key) ?? [];
    list.push(q);
    byGroup.set(q.key, list);
  }

  const out: GroupRowModel[] = [];
  for (const [key, rows] of byGroup) {
    const head = rows[0];
    const curves: ParticipantCurve[] = dataset.results.map((r) => {
      const g = groupFor(r, head, view);
      const pts = g && g.status === 'ok' ? usablePoints(g.points ?? [], metric) : [];
      const front = frontier(pts, direction);
      return {
        pid: r.id,
        front,
        reach: front.length ? front[front.length - 1].recall : null,
        value: null,
        lead: null,
      };
    });

    // The bar: the strongest the family declares that every participant with a
    // curve reaches. An exact row has no bar -- every participant answers it at
    // recall 1 or not at all.
    const live = curves.filter((c) => c.reach !== null);
    let bar: number | null = null;
    let barKind: GroupRowModel['barKind'] = 'none';
    if (head.exact) {
      barKind = 'exact';
    } else if (live.length) {
      // Readable, not merely reachable: a participant whose ladder steps over
      // the bar by more than the gap limit cannot be read there either, and a
      // bar one of them cannot be read at is a bar that puts a word in the row.
      const readable = (b: number) => live.every((c) => valueAt(c.front, direction, b) !== null);
      const lowestReach = Math.min(...live.map((c) => c.reach as number));
      const declared = barsOf(rows).find((b) => b <= lowestReach + 1e-9 && readable(b));
      if (declared !== undefined) {
        bar = declared;
        barKind = 'declared';
      } else if (readable(lowestReach)) {
        bar = lowestReach;
        barKind = 'common-reach';
      } else {
        // Every candidate is stepped over by someone. Walk down the reaches --
        // each is a measured point for the participant that owns it, so the
        // lowest one every curve can be read at is the strongest honest bar.
        const cands = [...new Set(live.map((c) => c.reach as number))].sort((a, b) => b - a);
        const found = cands.find((b) => b <= lowestReach + 1e-9 && readable(b));
        if (found !== undefined) {
          bar = found;
          barKind = 'common-reach';
        }
      }
    }

    for (const c of curves) {
      const v =
        barKind === 'exact'
          ? c.front.length
            ? c.front[c.front.length - 1].value
            : null
          : bar === null
            ? null
            : valueAt(c.front, direction, bar);
      (c as { value: number | null }).value = v;
    }

    if (live.length) {
      const lo = Math.min(...live.map((c) => (c.front.length ? c.front[0].recall : 1)));
      const hi = Math.max(...live.map((c) => c.reach as number));
      if (hi > lo) leads(curves, direction, lo, hi);
    }

    let best: number | null = null;
    const cmp = better(direction);
    for (const c of curves) if (c.value !== null && (best === null || cmp(c.value, best))) best = c.value;

    const declaredBars = barsOf(rows);
    const floor = declaredBars.length ? declaredBars[declaredBars.length - 1] : null;
    out.push({
      key,
      floor,
      qualityGap: !head.exact && bar !== null && floor !== null && bar < floor - 1e-9,
      section: head.section,
      filter: head.filter,
      k: head.k,
      exact: head.exact,
      qids: rows.map((r) => r.id),
      bar,
      barKind,
      curves,
      best,
    });
  }
  return out;
}
