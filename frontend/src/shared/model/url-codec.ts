/* The shareable-link codec — searchbench's `?s=<base64url json>` wire format
   with VectorBench's slots. People quote results by pasting the URL, so:

     - key order in the packed object is `put()` call order (JSON.stringify
       writes keys in insertion order and the base64 depends on it);
     - `csv()` sorts with the default comparator;
     - a slot is written only when it deviates from the default, so the default
       link is `?s=eyJ2IjoxfQ`;
     - readable parameters next to `?s=` (`?view=latency&chips=k:10`) override
       the packed state and are canonicalised back into it on the next render.

   The theme is the platform's (`useTheme()`), so the codec takes it as an
   argument and hands a restored one back to apply via `setTheme`. Its default
   here is `light`. */

import type { BenchState, CellMode, LatencyMetric, SortSection, View } from './state.ts';
import { isLatencyMetric } from './state.ts';

/** Mirrors @serenedb/ui's `Theme`, without importing it into a pure module. */
export type ThemeName = 'dark' | 'light';

/** Everything the codec validates against, supplied by entities/results. */
export interface CodecEnv {
  /** Every `<family>-<size>` with results. */
  datasets: readonly string[];
  defaultDataset: string | null;
  /** Chip tags a dataset's family offers; unknown chips are dropped on restore. */
  tagsFor: (dataset: string) => ReadonlySet<string>;
  /** Query ids of a dataset's family; unknown rows are dropped on restore. */
  rowsFor: (dataset: string) => ReadonlySet<string>;
}

/** The decoded `?s=` payload. Short keys, `v` is the format version. */
export type PackedState = Record<string, unknown> & { v?: unknown };

export interface RestoredState {
  /** Applied over INITIAL_STATE by the caller. */
  patch: Partial<BenchState>;
  /** Non-null when the link pins a theme; apply with `useTheme().setTheme`. */
  theme: ThemeName | null;
}

function csv(values: Iterable<string>): string {
  return [...values].filter(Boolean).sort().join(',');
}

export function base64UrlEncode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string | null): PackedState | null {
  if (!value) return null;
  try {
    const padded =
      value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as PackedState | null;
    return parsed && parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Keep only deviations from the initial UI. */
export function shortState(state: BenchState, env: CodecEnv, theme: ThemeName): PackedState {
  const compact: PackedState = { v: 1 };
  const put = (key: string, value: unknown, defaultValue: unknown) => {
    if (value !== defaultValue && value != null && value !== '') compact[key] = value;
  };
  put('d', state.dataset ?? env.defaultDataset, env.defaultDataset);
  put('t', state.view, 'throughput');
  put('m', state.latencyMetric, 'p50');
  put('c', state.cells, 'relative');
  put('q', csv(state.chips), '');
  put('s', state.sortSection, 'nofilter');
  put('r', state.openRow, null);
  put('g', (state.graphRows ?? []).join(','), '');
  put('th', theme, 'light');
  return compact;
}

/**
 * Canonicalise the address bar to a single `?s=` parameter, with
 * `history.replaceState` so a chip or a row click never pushes a route.
 */
export function syncUrlState(state: BenchState, env: CodecEnv, theme: ThemeName): void {
  try {
    const p = new URLSearchParams();
    p.set('s', base64UrlEncode(shortState(state, env, theme)));
    const query = p.toString();
    const next = window.location.pathname + (query ? '?' + query : '') + window.location.hash;
    window.history.replaceState(null, '', next);
  } catch {
    /* history is unavailable (sandboxed iframe) — the view still works */
  }
}

/** Readable parameter name → its slot in the packed payload. */
const FIELDS: Record<string, string> = {
  dataset: 'd',
  view: 't',
  metric: 'm',
  cells: 'c',
  chips: 'q',
  sort: 's',
  row: 'r',
  graph: 'g',
  theme: 'th',
};

/**
 * Read `?s=` plus the readable overrides next to it.
 * @param search `window.location.search`
 * @param initial defaults every unset field falls back to (INITIAL_STATE)
 */
export function restoreUrlState(search: string, env: CodecEnv, initial: BenchState): RestoredState {
  const patch: Partial<BenchState> = {};
  let theme: ThemeName | null = null;
  try {
    const p = new URLSearchParams(search);
    const packed = base64UrlDecode(p.get('s'));
    const get = (key: string): unknown =>
      p.has(key) ? p.get(key) : packed ? packed[FIELDS[key]] : null;
    const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T | null) => {
      const v = get(key);
      return allowed.includes(v as T) ? (v as T) : fallback;
    };
    const split = (key: string) => String(get(key) || '').split(',').filter(Boolean);

    const dataset = get('dataset');
    if (typeof dataset === 'string' && env.datasets.includes(dataset)) patch.dataset = dataset;
    const ds = patch.dataset ?? env.defaultDataset;
    const tags = ds ? env.tagsFor(ds) : new Set<string>();
    const rows = ds ? env.rowsFor(ds) : new Set<string>();

    patch.view = oneOf<View>('view', ['throughput', 'latency'], initial.view)!;
    const metric = get('metric');
    patch.latencyMetric = isLatencyMetric(metric) ? (metric as LatencyMetric) : initial.latencyMetric;
    patch.cells = oneOf<CellMode>('cells', ['relative', 'absolute'], initial.cells)!;
    patch.chips = new Set(split('chips').filter((t) => tags.has(t)));
    patch.sortSection = oneOf<SortSection>('sort', ['nofilter', 'filtered'], initial.sortSection)!;
    const row = get('row');
    patch.openRow = typeof row === 'string' && rows.has(row) ? row : null;
    const graph = split('graph').filter((id) => rows.has(id));
    patch.graphRows = graph.length ? graph : null;
    theme = oneOf<ThemeName>('theme', ['dark', 'light'], null);
  } catch {
    /* a malformed link opens the default view rather than a blank page */
  }
  return { patch, theme };
}
