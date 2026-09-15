/* Every transition the page has, one action per gesture. Pure: Sets and arrays
   are replaced, never mutated, and any guard that needs the data travels in the
   action payload (`tags` on `dataset`), so shared/model never imports upward. */

import type { BenchState, CellMode, Detail, LatencyMetric, SortSection, View } from './state.ts';

export type BenchAction =
  /** `tags`: every chip tag the new dataset's family offers; stale chips are dropped. */
  | { type: 'dataset'; id: string; tags: ReadonlySet<string> }
  | { type: 'view'; value: View }
  | { type: 'metric'; value: LatencyMetric }
  | { type: 'cells'; value: CellMode }
  | { type: 'chip'; tag: string }
  | { type: 'clear-chips' }
  | { type: 'sort'; section: SortSection }
  /** Toggle the inline graph under a query row. */
  | { type: 'row'; id: string }
  /** Open the full-screen graph with this row (and the inline one, if any). */
  | { type: 'graph-open'; id: string }
  | { type: 'graph-toggle'; id: string }
  | { type: 'graph-close' }
  | { type: 'detail'; detail: Detail }
  | { type: 'detail-close' }
  /** Escape: the detail first, then the full-screen graph. */
  | { type: 'escape' };

export function benchReducer(state: BenchState, action: BenchAction): BenchState {
  switch (action.type) {
    case 'dataset': {
      if (action.id === state.dataset) return state;
      // Another dataset is another family's rows: whatever was open names rows
      // that may not exist there, and chips that no row answers to would hide
      // the whole table.
      const chips = new Set([...state.chips].filter((t) => action.tags.has(t)));
      return { ...state, dataset: action.id, chips, openRow: null, graphRows: null, detail: null };
    }
    case 'view':
      return { ...state, view: action.value };
    case 'metric':
      return { ...state, latencyMetric: action.value };
    case 'cells':
      return { ...state, cells: action.value };
    case 'chip': {
      const next = new Set(state.chips);
      if (next.has(action.tag)) next.delete(action.tag);
      else next.add(action.tag);
      return { ...state, chips: next };
    }
    case 'clear-chips':
      return { ...state, chips: new Set() };
    case 'sort':
      return { ...state, sortSection: action.section };
    case 'row':
      return { ...state, openRow: state.openRow === action.id ? null : action.id };
    case 'graph-open': {
      const rows = [action.id];
      if (state.openRow && state.openRow !== action.id) rows.push(state.openRow);
      for (const r of state.graphRows ?? []) if (!rows.includes(r)) rows.push(r);
      return { ...state, graphRows: rows };
    }
    case 'graph-toggle': {
      const rows = state.graphRows ?? [];
      const next = rows.includes(action.id) ? rows.filter((r) => r !== action.id) : [...rows, action.id];
      return { ...state, graphRows: next };
    }
    case 'graph-close':
      return { ...state, graphRows: null };
    case 'detail':
      return { ...state, detail: action.detail };
    case 'detail-close':
      return { ...state, detail: null };
    case 'escape':
      if (state.detail) return { ...state, detail: null };
      if (state.graphRows) return { ...state, graphRows: null };
      return state;
  }
}
