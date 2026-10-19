/* Which rows the chips leave visible. A chip is a tag (`filter:eq`, `k:10`,
   `recall:0.95`, `recall:exact`); within one dimension chips are OR-ed, across
   dimensions AND-ed, and an empty selection passes everything — searchbench's
   category filter, with three dimensions instead of one. */

import { fmtRecall } from '../../../shared/lib/format.ts';
import type { ChipGroups, QueryRow } from './model.ts';

export const CHIP_DIMENSIONS = ['filter', 'k', 'recall'] as const;
export type ChipDimension = (typeof CHIP_DIMENSIONS)[number];

export function chipTag(dimension: ChipDimension, value: string): string {
  return dimension + ':' + value;
}

export function rowPasses(row: QueryRow, active: ReadonlySet<string>): boolean {
  if (active.size === 0) return true;
  for (const dim of CHIP_DIMENSIONS) {
    const prefix = dim + ':';
    let wanted = false;
    let hit = false;
    for (const t of active) {
      if (!t.startsWith(prefix)) continue;
      wanted = true;
      if (row.tags.includes(t)) hit = true;
    }
    if (wanted && !hit) return false;
  }
  return true;
}

/** Rows a dataset declares that the chips leave visible. Takes the dataset's own row list, which
    is the family's resolved for that size (a size may skip rows or read them at another bar). */
export function visibleRows(rows: readonly QueryRow[], active: ReadonlySet<string>): QueryRow[] {
  return rows.filter((q) => rowPasses(q, active));
}

/** Every chip tag a family or dataset offers. */
export function allChipTags(owner: { chips: ChipGroups }): Set<string> {
  const out = new Set<string>();
  for (const dim of CHIP_DIMENSIONS) for (const v of owner.chips[dim]) out.add(chipTag(dim, v));
  return out;
}

/** What the chip says: `k=10`, `0.95`, `exact`, `eq`. */
export function chipLabel(dimension: ChipDimension, value: string): string {
  if (dimension === 'k') return 'k=' + value;
  if (dimension === 'recall') return value === 'exact' ? 'exact' : fmtRecall(Number(value));
  return value;
}

/** A row by what it asks, the way the table and the graph name it: k, then
    the filter case — `k=10 · eq-10`. k comes first because it is what changes
    from row to row inside a filter case's block (tableOrder). The no-filter
    case is left out, as the section heading says it; a group key (`eq-10/10`)
    says the same and is not printed. */
export function rowTitle(row: { filter: string; k: number }): string {
  return row.filter === 'none' ? `k=${row.k}` : `k=${row.k} · ${row.filter}`;
}

/** The order the table lists rows in: NO FILTER above FILTERED, and within a
    section one block per filter case — in the order the family first names
    each — its rows by k. A family may name a case's extra bars at the end of
    its list (eq-1 at 0.99, eq-1 exact); here they join their case's block, so
    a block's rows differ in k and bar alone. Stable: rows alike in both keep
    the family's order. */
export function tableOrder<T extends { section: string; filter: string; k: number }>(rows: readonly T[]): T[] {
  const out: T[] = [];
  for (const section of ['nofilter', 'filtered']) {
    const inSection = rows.filter((r) => r.section === section);
    const cases: string[] = [];
    for (const r of inSection) if (!cases.includes(r.filter)) cases.push(r.filter);
    for (const c of cases) out.push(...inSection.filter((r) => r.filter === c).sort((a, b) => a.k - b.k));
  }
  return out;
}
