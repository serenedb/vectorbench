/* The shape of frontend/results.json exactly as `vectorbench assemble` writes it
   (docs/contracts.md section 11), which is every result file (section 8) plus the
   family blocks (section 1, as `Family.to_page_dict()` emits them).

   Nothing here is derived: rows, crossings, scores and coverage are computed from
   these records in model.ts / cells.ts / scores.ts so that table, graph and
   detail can never disagree with each other or with the driver. */

/** A row's recall target: a float in (0, 1), or `exact` for the brute-force row. */
export type Recall = number | 'exact';

/** The load condition a group was measured under (contracts section 8, `views`). */
export type View = 'throughput' | 'latency';

export type GroupStatus = 'ok' | 'unsupported' | 'n/a' | 'error';

/** One table row, defined per family and identical for every size (section 1). */
export interface Query {
  id: string;
  filter: string;
  k: number;
  recall: Recall;
}

/** The family block of results.json — `Family.to_page_dict()` in lib/vectorbench/families.py. */
export interface RawFamily {
  family: string;
  title: string;
  description?: string;
  dims: number;
  metric: string;
  /** size name → row count: `{"100k": 100000, "1m": 1000000}`. */
  sizes: Record<string, number>;
  /** case name → predicate spec (section 3); `none` is `{}`. */
  filter_cases: Record<string, Record<string, unknown>>;
  queries: Query[];
  /** size → row id → the recall bar that size reads its cells at (contracts section 13). */
  recall_by_size?: Record<string, Record<string, Recall>>;
  /** size → row ids whose shape is meaningless there, so that size does not declare them. */
  skip_by_size?: Record<string, string[]>;
}

/** Every distribution is reported the same way (DESIGN.md 4.2 rule 8). */
export interface Stats {
  n: number;
  min: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface Pass {
  qps: number;
  avg: number;
  p50: number;
  p99: number;
  queries: number;
  duration: number;
}

/** One knob setting of a participant on a group, measured in full in one view. */
export interface RawPoint {
  ladder_index: number;
  knobs: Record<string, unknown>;
  /** Tie-aware recall@k from the first pass; null when it could not be computed. */
  recall: number | null;
  recall_strict?: number | null;
  /** Share of queries below 0.5 recall. */
  tail?: number | null;
  /** From the best pass (max qps); `latency_ms` is that pass's distribution. */
  qps: number;
  latency_ms: Stats;
  queries?: number;
  duration?: number;
  passes?: Pass[];
}

export interface RawGroup {
  /** `"<filter>/<k>"`, or `"exact/<filter>/<k>"` for the brute-force group. */
  key: string;
  filter: string;
  k: number;
  exact?: boolean;
  view: View;
  clients?: number;
  status: GroupStatus;
  /** Set for `n/a` and `error`. */
  reason?: string | null;
  /** The statement as it ran, knob variables unsubstituted. */
  block?: string;
  /** This group's startup sample, seconds. */
  startup?: number | null;
  /** cgroup memory.peak over this group, bytes. */
  memory_peak?: number | null;
  points?: RawPoint[];
}

export interface Hardware {
  cpus: number;
  cpuset: string;
  memory_bytes: number;
  host: string;
  storage: string;
}

/** One result file: a participant on one dataset size (contracts section 8). */
export interface RawResult {
  /** Directory name, e.g. `serenedb-ivf` — the column's identity. */
  participant: string;
  /** Column caption, e.g. `SereneDB IVF`. */
  name: string;
  system: string;
  /** The index family (`ivf`, `hnsw`), not the dataset family. */
  family: string;
  version: string;
  label: string | null;
  os: string;
  date: string;
  /** `<family>-<size>`. */
  dataset: string;
  tags: string[];
  hardware: Hardware;
  load_time: number | null;
  load_phases?: Record<string, number>;
  disk_bytes: number | null;
  disk_info?: Record<string, unknown>;
  memory_peak: { load: number | null; unfiltered: number | null; filtered: number | null };
  startup: Stats | null;
  index: { params: Record<string, unknown>; ddl: string };
  groups: RawGroup[];
  /** Provenance, added by the assembler: `serenedb-ivf/results/serenedb-ivf_wiki-v3-1024-100k.json`. */
  _source?: string;
}

export interface RawResults {
  /** ISO timestamp of the assembly. */
  generated: string;
  /** family id → block, in the assembler's (alphabetical) order. */
  families: Record<string, RawFamily>;
  results: RawResult[];
  /** Not written by `vectorbench assemble`. scripts/sample-results.mjs sets it so
      the page can say, in a banner, that every number is synthetic. */
  sample?: boolean;
}
