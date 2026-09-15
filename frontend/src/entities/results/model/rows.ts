/* Which rows the chips leave visible. A chip is a tag (`filter:eq`, `k:10`,
   `recall:0.95`, `recall:exact`); within one dimension chips are OR-ed, across
   dimensions AND-ed, and an empty selection passes everything — searchbench's
   category filter, with three dimensions instead of one. */

import { fmtRecall } from '../../../shared/lib/format.ts';
import type { FamilyModel, QueryRow } from './model.ts';

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

export function visibleRows(family: FamilyModel, active: ReadonlySet<string>): QueryRow[] {
  return family.queries.filter((q) => rowPasses(q, active));
}

/** Every chip tag a family offers. */
export function allChipTags(family: FamilyModel): Set<string> {
  const out = new Set<string>();
  for (const dim of CHIP_DIMENSIONS) for (const v of family.chips[dim]) out.add(chipTag(dim, v));
  return out;
}

/** What the chip says: `k=10`, `0.95`, `exact`, `eq`. */
export function chipLabel(dimension: ChipDimension, value: string): string {
  if (dimension === 'k') return 'k=' + value;
  if (dimension === 'recall') return value === 'exact' ? 'exact' : fmtRecall(Number(value));
  return value;
}
