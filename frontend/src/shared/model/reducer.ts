/* Every transition the page has, one action per gesture. Pure: Sets and arrays
   are replaced, never mutated, and any guard that needs the data travels in the
   action payload (`tags` on `dataset`), so shared/model never imports upward.
   For the same reason `plot` carries the whole next selection: a range or an
   "only this row" needs the rows on screen, which the table has and this does
   not. */

import type { BenchState, CellMode, Detail, LatencyMetric, RowMode, SortSection, View } from './state.ts';

export type BenchAction =
  /** `tags`: every chip tag the new dataset's family offers; stale chips are dropped. */
  | { type: 'dataset'; id: string; tags: ReadonlySet<string> }
  | { type: 'view'; value: View }
  | { type: 'metric'; value: LatencyMetric }
  | { type: 'cells'; value: CellMode }
  | { type: 'row-mode'; value: RowMode }
  | { type: 'chip'; tag: string }
  | { type: 'clear-chips' }
  /** `visibleCount`: participants shown *before* this click; hiding the last one is refused. */
  | { type: 'part'; pid: string; visibleCount: number }
  /** `present`: every participant of the dataset on screen, hidden ones included. */
  | { type: 'toggle-all'; present: readonly string[] }
  | { type: 'sort'; section: SortSection }
  /** The rows ticked for the graph, all of them. */
  | { type: 'plot'; ids: readonly string[] }
  | { type: 'detail'; detail: Detail }
  | { type: 'detail-close' }
  /** Escape: closes the detail. The graph is part of the page and stays. */
  | { type: 'escape' };

export function benchReducer(state: BenchState, action: BenchAction): BenchState {
  switch (action.type) {
    case 'dataset': {
      if (action.id === state.dataset) return state;
      // Another dataset is another family's rows: whatever was open names rows
      // that may not exist there, and chips that no row answers to would hide
      // the whole table.
      const chips = new Set([...state.chips].filter((t) => action.tags.has(t)));
      return { ...state, dataset: action.id, chips, graphRows: null, detail: null };
    }
    case 'view':
      return { ...state, view: action.value };
    case 'metric':
      return { ...state, latencyMetric: action.value };
    case 'cells':
      return { ...state, cells: action.value };
    case 'row-mode':
      // The ticked rows carry over (BenchPage reads a group key as its bars and
      // a bar as its group); the detail names a row of the other reading.
      return { ...state, rowMode: action.value, detail: null };
    case 'chip': {
      const next = new Set(state.chips);
      if (next.has(action.tag)) next.delete(action.tag);
      else next.add(action.tag);
      return { ...state, chips: next };
    }
    case 'clear-chips':
      return { ...state, chips: new Set() };
    case 'part': {
      const next = new Set(state.hidden);
      if (next.has(action.pid)) {
        next.delete(action.pid);
        return { ...state, hidden: next };
      }
      // searchbench's guard: one click never empties the table.
      if (action.visibleCount <= 1) return state;
      next.add(action.pid);
      return { ...state, hidden: next };
    }
    case 'toggle-all': {
      const allShown = action.present.length > 0 && !action.present.some((p) => state.hidden.has(p));
      // Participants hidden while another dataset was on screen are not in
      // `present`, so they keep their state.
      const next = new Set(state.hidden);
      for (const p of action.present) {
        if (allShown) next.add(p);
        else next.delete(p);
      }
      return { ...state, hidden: next };
    }
    case 'sort':
      return { ...state, sortSection: action.section };
    case 'plot':
      return { ...state, graphRows: action.ids };
    case 'detail':
      return { ...state, detail: action.detail };
    case 'detail-close':
      return { ...state, detail: null };
    case 'escape':
      return state.detail ? { ...state, detail: null } : state;
  }
}
