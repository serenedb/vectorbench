/* The benchmark as the page sees it, built once from results.json.

   `buildBenchmark` is pure and strict: it validates the contract shapes it
   reads (sections 1, 8, 11) and throws a ContractError naming the offending
   record, so a broken `vectorbench assemble` shows up as a message on the page
   rather than as a table with holes in it. Everything below it is derivation —
   rows into sections, tags for the chips, the group index per result — and
   nothing here is a measurement: cells are computed in cells.ts from the
   points, scores in scores.ts from the cells. */

import { assignColors } from '../../../shared/lib/color.ts';
import type { Query, RawFamily, RawGroup, RawResult, RawResults, Recall, View } from './types.ts';

export class ContractError extends Error {
  constructor(message: string) {
    super('results.json does not follow docs/contracts.md: ' + message);
    this.name = 'ContractError';
  }
}

/** NO FILTER (`filter == "none"`) or FILTERED (everything else) — contracts section 11. */
export type Section = 'nofilter' | 'filtered';

export const SECTIONS: readonly Section[] = ['nofilter', 'filtered'];

export const SECTION_TITLES: Record<Section, string> = {
  nofilter: 'NO FILTER',
  filtered: 'FILTERED',
};

export const VIEWS: readonly View[] = ['throughput', 'latency'];

/** A query row with everything the table derives from it once. */
export interface QueryRow extends Query {
  exact: boolean;
  /** Group key: `"<filter>/<k>"` or `"exact/<filter>/<k>"` (contracts section 1). */
  key: string;
  section: Section;
  /** `eq` for eq-10 / eq-1 / eq-0.1: the chip a row answers to. */
  caseBase: string;
  /** `filter:<caseBase>`, `k:<k>`, `recall:<recall|exact>` — the chip tags. */
  tags: readonly string[];
}

export interface ChipGroups {
  filter: string[];
  k: string[];
  recall: string[];
}

export interface SizeInfo {
  name: string;
  rows: number;
}

export interface FamilyModel {
  id: string;
  title: string;
  description: string;
  dims: number;
  metric: string;
  /** Declared sizes, smallest first. */
  sizes: SizeInfo[];
  /** Case names in definition order. */
  filterCases: string[];
  queries: QueryRow[];
  /** Chip values present in the query list, in display order. */
  chips: ChipGroups;
  raw: RawFamily;
}

export interface ResultModel {
  /** Participant id — the column's identity. */
  id: string;
  /** Column caption (`name` in the result file). */
  name: string;
  system: string;
  datasetId: string;
  family: FamilyModel;
  size: string;
  /** The family's rows resolved for this result's size (same list as its dataset's). */
  queries: QueryRow[];
  /** `groupLookupKey(view, key)` → group. */
  groups: ReadonlyMap<string, RawGroup>;
  raw: RawResult;
}

export interface DatasetModel {
  id: string;
  family: FamilyModel;
  size: string;
  rows: number;
  /** The family's rows resolved for this size: skipped rows dropped, recall bars overridden. */
  queries: QueryRow[];
  /** Chip values present in this size's rows, in display order. */
  chips: ChipGroups;
  /** In file order; the page sorts them (scores.ts). */
  results: ResultModel[];
}

export interface ParticipantInfo {
  id: string;
  name: string;
  system: string;
}

export interface Benchmark {
  generated: string;
  /** Set only by scripts/sample-results.mjs. */
  sample: boolean;
  /** In file order (the assembler writes them alphabetically). */
  families: FamilyModel[];
  /** Family order, then size ascending. Only sizes with at least one result. */
  datasets: DatasetModel[];
  /** Every participant in the file, sorted by id. */
  participants: ParticipantInfo[];
  colors: ReadonlyMap<string, string>;
  defaultDataset: string | null;
}

/* ---- small helpers, shared with the sample generator's expectations ------ */

export function groupKey(filter: string, k: number, exact: boolean): string {
  return exact ? `exact/${filter}/${k}` : `${filter}/${k}`;
}

export function groupLookupKey(view: View, key: string): string {
  return view + '|' + key;
}

/** `eq-0.1` → `eq`, `range-10` → `range`, `xcorr` → `xcorr`. */
export function caseBase(name: string): string {
  return name.replace(/-[0-9.]+$/, '');
}

export function recallTag(recall: Recall): string {
  return recall === 'exact' ? 'exact' : String(recall);
}

export function tagsOf(q: Query): string[] {
  return [`filter:${caseBase(q.filter)}`, `k:${q.k}`, `recall:${recallTag(q.recall)}`];
}

const DATASET_RE = /^(.+)-([0-9]+[km])$/;

/** `wiki-v3-1024-100k` → `["wiki-v3-1024", "100k"]`, as `split_dataset_id` in families.py. */
export function splitDatasetId(id: string): [string, string] | null {
  const m = DATASET_RE.exec(id);
  return m ? [m[1], m[2]] : null;
}

/* ---- validation --------------------------------------------------------- */

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function str(x: unknown, what: string): string {
  if (typeof x !== 'string' || !x) throw new ContractError(`${what} must be a non-empty string`);
  return x;
}

function buildFamily(id: string, raw: unknown): FamilyModel {
  if (!isObj(raw)) throw new ContractError(`family ${id} must be an object`);
  const f = raw as unknown as RawFamily;
  if (!isObj(f.sizes) || !Object.keys(f.sizes).length) throw new ContractError(`family ${id}: sizes must be a non-empty object`);
  if (!isObj(f.filter_cases)) throw new ContractError(`family ${id}: filter_cases must be an object`);
  if (!Array.isArray(f.queries)) throw new ContractError(`family ${id}: queries must be an array`);
  const sizes: SizeInfo[] = Object.entries(f.sizes)
    .map(([name, rows]) => {
      if (typeof rows !== 'number' || !(rows > 0)) throw new ContractError(`family ${id}: size ${name} must be a positive row count`);
      return { name, rows };
    })
    .sort((a, b) => a.rows - b.rows);
  const filterCases = Object.keys(f.filter_cases);
  const queries = buildRows(f.queries, id, filterCases);
  return {
    id,
    title: typeof f.title === 'string' && f.title ? f.title : id,
    description: typeof f.description === 'string' ? f.description : '',
    dims: typeof f.dims === 'number' ? f.dims : NaN,
    metric: typeof f.metric === 'string' ? f.metric : '',
    sizes,
    filterCases,
    queries,
    chips: chipGroups(filterCases, queries),
    raw: f,
  };
}

/** Validate and decorate a row list. `id` and `filterCases` only shape the error messages and
    reject a row naming a case the family does not declare. */
function buildRows(rows: readonly Query[], id: string, filterCases: readonly string[]): QueryRow[] {
  const seen = new Set<string>();
  return rows.map((q, i) => {
    if (!isObj(q)) throw new ContractError(`family ${id}: query #${i} must be an object`);
    const qid = str(q.id, `family ${id}: query #${i} id`);
    if (seen.has(qid)) throw new ContractError(`family ${id}: duplicate query id ${qid}`);
    seen.add(qid);
    const filter = str(q.filter, `family ${id}: query ${qid} filter`);
    if (!filterCases.includes(filter)) throw new ContractError(`family ${id}: query ${qid} uses unknown filter case ${filter}`);
    const k = q.k;
    if (typeof k !== 'number' || !Number.isInteger(k) || k <= 0) throw new ContractError(`family ${id}: query ${qid} k must be a positive integer`);
    const recall = q.recall;
    if (recall !== 'exact' && !(typeof recall === 'number' && recall > 0 && recall < 1)) {
      throw new ContractError(`family ${id}: query ${qid} recall must be a number in (0, 1) or "exact"`);
    }
    const exact = recall === 'exact';
    const query: Query = { id: qid, filter, k, recall: recall as Recall };
    return {
      ...query,
      exact,
      key: groupKey(filter, k, exact),
      section: filter === 'none' ? 'nofilter' : 'filtered',
      caseBase: caseBase(filter),
      tags: tagsOf(query),
    };
  });
}

/** The family's rows as one dataset size declares them: rows the size skips are dropped and the
    bars it overrides are applied, so a size's row list is what was actually measured there
    (contracts section 13). */
export function queriesForSize(family: FamilyModel, size: string): QueryRow[] {
  const raw = family.raw;
  const skip = new Set((raw.skip_by_size ?? {})[size] ?? []);
  const over = (raw.recall_by_size ?? {})[size] ?? {};
  const kept = raw.queries.filter((q) => !skip.has(q.id));
  const applied = kept.map((q) => (q.id in over ? { ...q, recall: over[q.id] } : q));
  return buildRows(applied, family.id, family.filterCases);
}

function chipGroups(filterCases: string[], queries: QueryRow[]): ChipGroups {
  const used = new Set(queries.map((q) => q.caseBase));
  const filter: string[] = [];
  for (const c of filterCases) {
    const b = caseBase(c);
    if (used.has(b) && !filter.includes(b)) filter.push(b);
  }
  const k = [...new Set(queries.map((q) => q.k))].sort((a, b) => a - b).map(String);
  const recalls = [...new Set(queries.filter((q) => !q.exact).map((q) => q.recall as number))].sort((a, b) => a - b);
  const recall = recalls.map(String);
  if (queries.some((q) => q.exact)) recall.push('exact');
  return { filter, k, recall };
}

function buildResult(raw: unknown, i: number, families: Map<string, FamilyModel>): ResultModel {
  if (!isObj(raw)) throw new ContractError(`results[${i}] must be an object`);
  const r = raw as unknown as RawResult;
  const where = r._source ? String(r._source) : `results[${i}]`;
  const dataset = str(r.dataset, `${where}: dataset`);
  const split = splitDatasetId(dataset);
  if (!split) throw new ContractError(`${where}: dataset ${dataset} is not <family>-<size>`);
  const [familyId, size] = split;
  const family = families.get(familyId);
  if (!family) throw new ContractError(`${where}: dataset ${dataset} has no family definition`);
  if (!family.sizes.some((s) => s.name === size)) throw new ContractError(`${where}: size ${size} is not declared by family ${familyId}`);
  const id = str(r.participant, `${where}: participant`);
  const name = str(r.name, `${where}: name`);
  if (!Array.isArray(r.groups)) throw new ContractError(`${where}: groups must be an array`);
  const groups = new Map<string, RawGroup>();
  r.groups.forEach((g, gi) => {
    if (!isObj(g)) throw new ContractError(`${where}: groups[${gi}] must be an object`);
    const key = str(g.key, `${where}: groups[${gi}] key`);
    const view = g.view;
    if (view !== 'throughput' && view !== 'latency') throw new ContractError(`${where}: group ${key} has view ${String(view)}, expected throughput or latency`);
    str(g.status, `${where}: group ${key} status`);
    const lk = groupLookupKey(view, key);
    if (groups.has(lk)) throw new ContractError(`${where}: group ${key} appears twice for view ${view}`);
    groups.set(lk, g as unknown as RawGroup);
  });
  return {
    id,
    name,
    system: typeof r.system === 'string' ? r.system : name,
    datasetId: dataset,
    family,
    size,
    queries: queriesForSize(family, size),
    groups,
    raw: r,
  };
}

/**
 * The default dataset: the first family (file order) with results, and in it
 * the largest size every one of the family's participants has a result for;
 * failing that, the size with the most participants, largest first.
 */
export function pickDefaultDataset(datasets: readonly DatasetModel[], families: readonly FamilyModel[]): string | null {
  for (const fam of families) {
    const id = defaultSizeOf(datasets, fam);
    if (id) return id;
  }
  return null;
}

function defaultSizeOf(datasets: readonly DatasetModel[], fam: FamilyModel): string | null {
  const ds = datasets.filter((d) => d.family === fam);
  if (!ds.length) return null;
  const everyone = new Set(ds.flatMap((d) => d.results.map((r) => r.id))).size;
  const complete = ds.filter((d) => d.results.length === everyone);
  if (complete.length) return complete[complete.length - 1].id;
  return [...ds].sort((a, b) => b.results.length - a.results.length || b.rows - a.rows)[0].id;
}

/** The dataset the family selector switches to: the family's default size, by the same rule. */
export function defaultDatasetOfFamily(bench: Benchmark, familyId: string): string | null {
  const fam = bench.families.find((f) => f.id === familyId);
  return fam ? defaultSizeOf(bench.datasets, fam) : null;
}

export function buildBenchmark(input: unknown): Benchmark {
  if (!isObj(input)) throw new ContractError('top level must be an object with families and results (section 11)');
  const raw = input as unknown as RawResults;
  if (!isObj(raw.families)) throw new ContractError('families must be an object keyed by family id');
  if (!Array.isArray(raw.results)) throw new ContractError('results must be an array');
  const families = Object.entries(raw.families).map(([id, f]) => buildFamily(id, f));
  const byId = new Map(families.map((f) => [f.id, f]));
  const results = raw.results.map((r, i) => buildResult(r, i, byId));

  const byDataset = new Map<string, ResultModel[]>();
  for (const r of results) {
    const list = byDataset.get(r.datasetId) ?? [];
    if (list.some((x) => x.id === r.id)) {
      throw new ContractError(`participant ${r.id} has two result files for ${r.datasetId}`);
    }
    list.push(r);
    byDataset.set(r.datasetId, list);
  }
  const datasets: DatasetModel[] = [];
  for (const fam of families) {
    for (const s of fam.sizes) {
      const id = `${fam.id}-${s.name}`;
      const list = byDataset.get(id);
      if (list) {
        const queries = queriesForSize(fam, s.name);
        datasets.push({
          id, family: fam, size: s.name, rows: s.rows, results: list,
          queries, chips: chipGroups(fam.filterCases, queries),
        });
      }
    }
  }
  const seen = new Map<string, ParticipantInfo>();
  for (const r of results) if (!seen.has(r.id)) seen.set(r.id, { id: r.id, name: r.name, system: r.system });
  const participants = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    generated: typeof raw.generated === 'string' ? raw.generated : '',
    sample: raw.sample === true,
    families,
    datasets,
    participants,
    colors: assignColors(participants),
    defaultDataset: pickDefaultDataset(datasets, families),
  };
}
