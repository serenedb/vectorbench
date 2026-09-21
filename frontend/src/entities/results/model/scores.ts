/* Scores and coverage — contracts section 10 — and the column order they give.

   Per section and the visible rows: `best` is the best ok value in the row;
   a participant's ratio is best/value (higher is better) or value/best (lower);
   its score is the geometric mean of its ratios over the rows where it is ok;
   its coverage is ok rows / visible rows. Columns sort by coverage descending,
   then score ascending (1.00 is best). Memory peaks and startup are shown,
   never scored. */

import { cellValue, type Direction } from './frontier.ts';
import { gridCell, type Grid } from './cells.ts';
import type { QueryRow, ResultModel, Section } from './model.ts';
import type { GroupRowModel, ParticipantCurve } from './groupRows.ts';

export interface Coverage {
  ok: number;
  total: number;
}

export interface SectionScores {
  section: Section;
  /** participant id → geomean of its ratios, or null when it is ok on no visible row. */
  score: ReadonlyMap<string, number | null>;
  coverage: ReadonlyMap<string, Coverage>;
}

/** best/value or value/best, so the row's best is 1 and everything else is above 1. */
export function ratioTo(value: number, best: number, direction: Direction): number {
  return direction === 'higher' ? best / value : value / best;
}

export function sectionScores(
  grid: Grid,
  results: readonly ResultModel[],
  rows: readonly QueryRow[],
  section: Section,
): SectionScores {
  const score = new Map<string, number | null>();
  const coverage = new Map<string, Coverage>();
  for (const r of results) {
    let logSum = 0;
    let ok = 0;
    for (const row of rows) {
      const v = cellValue(gridCell(grid, row.id, r.id));
      const best = grid.best.get(row.id);
      if (v === null || best == null) continue;
      logSum += Math.log(ratioTo(v, best, grid.direction));
      ok++;
    }
    score.set(r.id, ok ? Math.exp(logSum / ok) : null);
    coverage.set(r.id, { ok, total: rows.length });
  }
  return { section, score, coverage };
}

/** The same geomean and coverage over group rows, for the by-group reading.

   A group row is counted when the row has a bar every participant can be read
   at; a row where the engines differ in what they can answer at all
   (`qualityGap`) is no more a speed comparison here than it was a cell, so it
   counts towards neither score nor coverage for anybody. */
export function sectionScoresByGroup(
  rows: readonly GroupRowModel[],
  results: readonly ResultModel[],
  direction: Direction,
  section: Section,
): SectionScores {
  const mine = rows.filter((g) => g.section === section);
  const scored = mine.filter((g) => !g.qualityGap && g.best !== null);
  const score = new Map<string, number | null>();
  const coverage = new Map<string, Coverage>();
  for (const r of results) {
    let logSum = 0;
    let ok = 0;
    for (const g of scored) {
      const c = g.curves.find((x: ParticipantCurve) => x.pid === r.id);
      if (!c || c.value === null || g.best === null) continue;
      logSum += Math.log(ratioTo(c.value, g.best, direction));
      ok++;
    }
    score.set(r.id, ok ? Math.exp(logSum / ok) : null);
    coverage.set(r.id, { ok, total: scored.length });
  }
  return { section, score, coverage };
}

/** Coverage descending, score ascending (null last), name as the tiebreak. Does not mutate. */
export function orderResults(results: readonly ResultModel[], s: SectionScores): ResultModel[] {
  return [...results].sort((a, b) => {
    const ca = s.coverage.get(a.id)?.ok ?? 0;
    const cb = s.coverage.get(b.id)?.ok ?? 0;
    if (ca !== cb) return cb - ca;
    const sa = s.score.get(a.id) ?? Infinity;
    const sb = s.score.get(b.id) ?? Infinity;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
