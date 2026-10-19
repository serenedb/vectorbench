/* Which rows the table shows as ticked and the graph draws, in the reading on
   screen.

   The selection is kept as the ids the reader ticked, of either kind — a query
   id from the bar reading, a group key from the group one (state.ts) — and is
   read here in the current reading: a group stands for its bars, a bar for its
   group. So switching the reading keeps what was ticked, and a link minted in
   one reading opens right in the other.

   Rows the chips hide stay ticked: unticking happens in the table, and the
   table cannot show them. The graph draws the ticked rows on screen. */

import type { DatasetModel, QueryRow } from '../../../entities/results';
// The module itself, not the slice's index: node runs this file straight from
// source in tests/model.test.mjs, and the index would pull in the results file.
import { tableOrder } from '../../../entities/results/model/rows.ts';
import type { RowMode } from '../../../shared/model';

/** The ids the table lists, in its order (tableOrder). */
export function screenRows(visible: readonly QueryRow[], mode: RowMode): string[] {
  const out: string[] = [];
  for (const q of tableOrder(visible)) {
    const id = mode === 'groups' ? q.key : q.id;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** How many rows the reading has with no chip on. */
export function readingSize(dataset: DatasetModel, mode: RowMode): number {
  return mode === 'groups' ? new Set(dataset.queries.map((q) => q.key)).size : dataset.queries.length;
}

/** The ticked ids in this reading, in the order they were ticked; nothing picked yet ticks the first row on screen. */
export function tickedRows(selection: readonly string[] | null, mode: RowMode, dataset: DatasetModel, onScreen: readonly string[]): string[] {
  if (selection === null) return onScreen.slice(0, 1);
  const out: string[] = [];
  const add = (id: string) => {
    if (!out.includes(id)) out.push(id);
  };
  for (const id of selection) {
    const query = dataset.queries.find((q) => q.id === id);
    if (mode === 'groups') {
      if (query) add(query.key);
      else if (dataset.queries.some((q) => q.key === id)) add(id);
    } else if (query) {
      add(query.id);
    } else {
      for (const q of dataset.queries) if (q.key === id) add(q.id);
    }
  }
  return out;
}
