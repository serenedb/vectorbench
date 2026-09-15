#!/usr/bin/env node
/* Deterministic synthetic frontend/results.json — SAMPLE DATA, NOT MEASUREMENTS.

   Real results do not exist yet. This script writes a results.json that follows
   docs/contracts.md sections 8 and 11 exactly (the same shape `vectorbench
   assemble` writes, plus a top-level `"sample": true` the page shows as a
   banner) so the page can be built, tested and looked at. `vectorbench assemble`
   overwrites the file once participants have run.

   What it makes up, and how:

   - two datasets, wiki-v3-1024-100k and sift-128-100k; the family blocks (incl.
     the query lists) come from datasets/*.yml, converted exactly as
     Family.to_page_dict() does;
   - four participants: SereneDB IVF, SereneDB HNSW, Qdrant HNSW, pgvector HNSW;
   - per group a ladder of about seven integer knob values designed around the
     recalls the group's rows ask for (as a participant would after `trace`),
     recall rising and QPS falling along it, both views;
   - every group of SereneDB HNSW with a filter is `unsupported` (DESIGN.md 5.1);
   - `n/a` groups follow the degenerate rule (contracts section 3) applied to the
     nominal selectivity of each predicate spec at 100k rows;
   - pgvector's `none/10` ladder stops at recall ~0.97 (a `reached 0.97` cell),
     Qdrant's `xcorr/10` ladder is a sparse doubling one (a `bracket too wide`
     cell at 0.95), pgvector's `eq-10/1000` is an `error`;
   - exact groups have one knob-less point at recall 1.0.

   Everything is seeded from names, so the output is byte-identical run to run.

   Usage: node scripts/sample-results.mjs [--stdout | <out.json>] */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const FRONTEND = new URL('../', import.meta.url);
export const DATASETS_DIR = new URL('../../datasets/', import.meta.url);

const GENERATED = '2026-09-14T12:00:00+00:00';
const DATE = '2026-09-14';
const SIZE = '100k';
const OS = 'Ubuntu 24.04.4 LTS';
const HARDWARE = {
  cpus: 32,
  cpuset: '0-31',
  memory_bytes: 68719476736,
  host: 'sample host (synthetic), 96 vCPU, 192 GiB',
  storage: 'nvme',
};
const VIEWS = [
  { view: 'throughput', clients: 32 },
  { view: 'latency', clients: 1 },
];

/* ---- deterministic randomness --------------------------------------------- */

function hash32(s) {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 seeded from a string. */
function rng(seed) {
  let a = hash32(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const jitter = (rand, pct) => 1 + (rand() * 2 - 1) * pct;
const round = (x, d) => Number(x.toFixed(d));

/* ---- families: datasets/*.yml → the section 11 block ---------------------- */

export async function loadFamilies(dir = DATASETS_DIR) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.yml')).sort();
  const out = {};
  for (const n of names) {
    const raw = YAML.parse(await readFile(new URL(n, dir), 'utf8'));
    out[raw.family] = {
      family: raw.family,
      title: raw.title ?? raw.family,
      description: String(raw.description ?? '').trim(),
      dims: raw.dims,
      metric: raw.metric,
      sizes: Object.fromEntries(Object.entries(raw.sizes).map(([k, v]) => [String(k), Number(v)])),
      filter_cases: Object.fromEntries(Object.entries(raw.filter_cases).map(([k, v]) => [String(k), v ?? {}])),
      queries: raw.queries.map((q) => ({
        id: String(q.id),
        filter: String(q.filter),
        k: Number(q.k),
        recall: q.recall === 'exact' ? 'exact' : Number(q.recall),
      })),
      // not part of the page block; used below for selectivities and the block text
      _source: raw.source ?? {},
    };
  }
  return out;
}

/** Nominal matching rows of a predicate spec at `rows` rows (contracts section 3). */
function matchesFor(spec, rows, langs) {
  if (!spec || !spec.op) return rows;
  if (spec.op === 'eq') {
    if (spec.field === 'cat10') return rows / 10;
    if (spec.field === 'cat100') return rows / 100;
    if (spec.field === 'cat1000') return rows / 1000;
    if (spec.field === 'cluster') return Math.round(rows / 100 * 0.98); // k-means: median cluster a bit under 1%
    if (spec.field === 'lang') return Math.round(rows / Math.max(1, langs));
    return rows / 10;
  }
  if (spec.op === 'range') return Math.round(rows * Number(spec.fraction));
  if (spec.op === 'and') {
    let m = rows;
    for (const t of spec.terms ?? []) m *= matchesFor(t, rows, langs) / rows;
    return Math.round(m);
  }
  return rows;
}

/** The predicate in SQL, with the driver's named parameters. */
function predicateSql(spec) {
  if (!spec || !spec.op) return '';
  if (spec.op === 'eq') return spec.field === 'lang' ? 'lang = $s' : `${spec.field} = $v`;
  if (spec.op === 'range') return `${spec.field} BETWEEN $lo AND $hi`;
  if (spec.op === 'and') return (spec.terms ?? []).map(predicateSql).join(' AND ');
  return '';
}

/** The predicate in Qdrant's filter JSON. */
function predicateQdrant(spec) {
  if (!spec || !spec.op) return null;
  if (spec.op === 'eq') return { key: spec.field, match: { value: spec.field === 'lang' ? '$s' : '$v' } };
  if (spec.op === 'range') return { key: spec.field, range: { gte: '$lo', lte: '$hi' } };
  if (spec.op === 'and') return { must: (spec.terms ?? []).map(predicateQdrant) };
  return null;
}

/* ---- participants ---------------------------------------------------------- */

const SQL_OP = { ip: '<#>', l2: '<->' };

/** Family-level factors: sift (128-d, easy descriptors) is faster and easier than wiki. */
const FAMILY = {
  'wiki-v3-1024': { qps: 1, hard: 1, bytes: 1, load: 1, strictGap: 0.003 },
  'sift-128': { qps: 2.3, hard: 0.78, bytes: 0.34, load: 0.42, strictGap: 0.018 },
};
const famOf = (family) => FAMILY[family] ?? { qps: 1, hard: 1, bytes: 1, load: 1, strictGap: 0.005 };

const COMMON_FILTER_HARD = {
  none: 1, 'eq-10': 1.05, 'eq-1': 1.15, 'eq-0.1': 1.3, 'range-10': 1.05, 'range-1': 1.15,
  'and-1': 1.2, corr: 0.85, xcorr: 1.6, lang: 1.05, xlang: 1.1,
};

const PARTICIPANTS = [
  {
    participant: 'serenedb-ivf', name: 'SereneDB IVF', system: 'SereneDB', family: 'ivf',
    version: '26.09.1', tags: ['C++', 'SereneDB', 'Postgres-wire'],
    knob: 'nprobe', xmin: 1,
    curve: { c: 0.5, p: 1.05 }, kHard: { 10: 1, 100: 1.4, 1000: 2.3 }, filterHard: COMMON_FILTER_HARD,
    qps0: 26000, kQps: { 10: 1, 100: 0.7, 1000: 0.24 },
    filterQps: { none: 1, 'eq-10': 0.82, 'eq-1': 0.78, 'eq-0.1': 0.92, 'range-10': 0.76, 'range-1': 0.72, 'and-1': 0.7, corr: 0.8, xcorr: 0.7, lang: 0.82, xlang: 0.8 },
    decay: { m: 1.2, alpha: 0.9 }, eff1: 0.78, exactQps: 410, exactFilteredBoost: 9,
    load: { time: 14.2, phases: { ingest: 5.1, index: 7.4, compaction: 1.2 } },
    disk: { bytes: 0.31e9, info: (b) => ({ segments: 3, index_bytes: Math.round(b * 0.93), quant: 'sq8' }) },
    memory: { load: 2.9e9, unfiltered: 1.6e9, filtered: 1.8e9 }, startupS: 1.2, memJitter: 0.06,
    params: { quant: 'sq8', posting_size: 1024 },
    ddl: (dims, metric) => `CREATE INDEX items_ivf ON items USING inverted(id, cat10, cat100, cat1000, num, cluster, lang, title, emb ivf (metric = '${metric}', quant = 'sq8'))`,
    block: (spec, metric, exact) => {
      const where = predicateSql(spec);
      const w = where ? ` WHERE ${where}` : '';
      const q = `SELECT id FROM items${w} ORDER BY emb ${SQL_OP[metric]} $q LIMIT $k;`;
      return exact ? `SET sdb_disable_top_k_optimization = true;\n${q}` : `SET sdb_ivf_search_nprobe = {nprobe};\n${q}`;
    },
  },
  {
    participant: 'serenedb-hnsw', name: 'SereneDB HNSW', system: 'SereneDB', family: 'hnsw',
    version: '26.09.1', tags: ['C++', 'SereneDB', 'Postgres-wire'],
    knob: 'ef', xmin: 16,
    curve: { c: 0.35, p: 1.2 }, kHard: { 10: 6, 100: 46, 1000: 390 }, filterHard: COMMON_FILTER_HARD,
    qps0: 34000, kQps: { 10: 1, 100: 0.62, 1000: 0.18 },
    filterQps: { none: 1 },
    decay: { m: 4, alpha: 0.8 }, eff1: 0.8, exactQps: 405, exactFilteredBoost: 9,
    unsupportedFiltered: true,
    load: { time: 38.6, phases: { ingest: 5.3, index: 29.8, compaction: 1.4 } },
    disk: { bytes: 0.52e9, info: (b) => ({ segments: 3, index_bytes: Math.round(b * 0.96), quant: 'sq8', m: 32 }) },
    memory: { load: 4.1e9, unfiltered: 2.4e9, filtered: null }, startupS: 1.9, memJitter: 0.06,
    params: { quant: 'sq8', m: 32, ef_construction: 200 },
    ddl: (dims, metric) => `CREATE INDEX items_hnsw ON items USING inverted(id, cat10, cat100, cat1000, num, cluster, lang, title, emb hnsw (metric = '${metric}', quant = 'sq8', m = 32, ef_construction = 200))`,
    block: (spec, metric, exact) => {
      const q = `SELECT id FROM items ORDER BY emb ${SQL_OP[metric]} $q LIMIT $k;`;
      return exact ? `SET sdb_disable_top_k_optimization = true;\n${q}` : `SET sdb_hnsw_ef_search = {ef};\n${q}`;
    },
  },
  {
    participant: 'qdrant-hnsw', name: 'Qdrant HNSW', system: 'Qdrant', family: 'hnsw',
    version: '1.15.1', tags: ['Rust', 'Qdrant', 'gRPC'],
    knob: 'hnsw_ef', xmin: 16,
    curve: { c: 0.33, p: 1.15 }, kHard: { 10: 5.5, 100: 42, 1000: 360 },
    filterHard: { ...COMMON_FILTER_HARD, 'eq-0.1': 1.5, xcorr: 1.9, 'and-1': 1.35 },
    qps0: 30000, kQps: { 10: 1, 100: 0.65, 1000: 0.2 },
    filterQps: { none: 1, 'eq-10': 0.7, 'eq-1': 0.36, 'eq-0.1': 0.11, 'range-10': 0.66, 'range-1': 0.31, 'and-1': 0.3, corr: 0.5, xcorr: 0.13, lang: 0.7, xlang: 0.7 },
    decay: { m: 4, alpha: 0.85 }, eff1: 0.72, exactQps: 380, exactFilteredBoost: 7,
    sparseGroups: ['xcorr/10'],
    load: { time: 52.4, phases: { upload: 18.7, index: 26.1, optimize: 6.2 } },
    disk: { bytes: 0.61e9, info: (b) => ({ segments: 4, vectors_bytes: Math.round(b * 0.71), payload_index_bytes: Math.round(b * 0.09), on_disk_payload: true }) },
    memory: { load: 3.6e9, unfiltered: 2.9e9, filtered: 3.1e9 }, startupS: 4.1, memJitter: 0.05,
    params: { m: 16, ef_construct: 200, quantization: 'scalar int8', default_segment_number: 4 },
    ddl: (dims, metric) => JSON.stringify({ vectors: { size: dims, distance: metric === 'ip' ? 'Dot' : 'Euclid' }, hnsw_config: { m: 16, ef_construct: 200 }, quantization_config: { scalar: { type: 'int8', always_ram: true } } }),
    block: (spec, metric, exact) => {
      const body = { limit: '$k', params: exact ? { exact: true } : { hnsw_ef: '{hnsw_ef}' } };
      const f = predicateQdrant(spec);
      if (f) body.filter = f.must ? f : { must: [f] };
      return JSON.stringify(body);
    },
  },
  {
    participant: 'pgvector-hnsw', name: 'pgvector HNSW', system: 'PostgreSQL', family: 'hnsw',
    version: '0.8.1 (PostgreSQL 18.0)', tags: ['C', 'PostgreSQL', 'pgvector'],
    knob: 'ef_search', xmin: 20,
    curve: { c: 0.3, p: 1.1 }, kHard: { 10: 7, 100: 55, 1000: 480 },
    filterHard: { ...COMMON_FILTER_HARD, 'eq-0.1': 1.6, xcorr: 2.0, 'and-1': 1.4 },
    qps0: 9500, kQps: { 10: 1, 100: 0.5, 1000: 0.1 },
    filterQps: { none: 1, 'eq-10': 0.7, 'eq-1': 0.2, 'eq-0.1': 0.06, 'range-10': 0.66, 'range-1': 0.2, 'and-1': 0.18, corr: 0.3, xcorr: 0.06, lang: 0.7, xlang: 0.7 },
    decay: { m: 4, alpha: 0.9 }, eff1: 0.55, exactQps: 96, exactFilteredBoost: 10,
    cappedGroups: { 'none/10': 0.972 },
    errorGroups: { 'eq-10/1000': 'hnsw.iterative_scan exhausted hnsw.max_scan_tuples before k rows: returned 812 of 1000 ids' },
    load: { time: 71.3, phases: { copy: 9.8, index: 55.2, vacuum: 3.9 } },
    disk: { bytes: 0.95e9, info: (b) => ({ relation_bytes: Math.round(b * 0.47), index_bytes: Math.round(b * 0.53), maintenance_work_mem: '16GB' }) },
    memory: { load: 6.2e9, unfiltered: 4.4e9, filtered: 4.9e9 }, startupS: 0.8, memJitter: 0.04,
    params: { m: 16, ef_construction: 200, iterative_scan: 'relaxed_order' },
    ddl: (dims, metric) => `CREATE INDEX items_hnsw ON items USING hnsw (emb ${metric === 'ip' ? 'vector_ip_ops' : 'vector_l2_ops'}) WITH (m = 16, ef_construction = 200)`,
    block: (spec, metric, exact) => {
      const where = predicateSql(spec);
      const w = where ? ` WHERE ${where}` : '';
      const q = `SELECT id FROM items${w} ORDER BY emb ${SQL_OP[metric]} $q LIMIT $k;`;
      return exact
        ? `SET enable_indexscan = off;\nSET enable_bitmapscan = off;\n${q}`
        : `SET hnsw.ef_search = {ef_search};\nSET hnsw.iterative_scan = relaxed_order;\nSET hnsw.max_scan_tuples = 200000;\n${q}`;
    },
  },
];

/* ---- the synthetic curve ---------------------------------------------------- */

/** recall(x) = 1 - c * (x / h)^-p, x the knob, h the hardness of (filter, k, family). */
function curveFor(p, filter, k, fam) {
  const h = (p.kHard[k] ?? p.kHard[10]) * (p.filterHard[filter] ?? 1) * fam.hard;
  const { c, p: pw } = p.curve;
  const f = (x) => Math.min(0.9995, Math.max(0.02, 1 - c * Math.pow(x / h, -pw)));
  const finv = (r) => h * Math.pow((1 - r) / c, -1 / pw);
  return { f, finv, h };
}

/** About seven integer knob values bracketing every target recall (±8%), an anchor near 0.80 and one point past the top row. */
function designLadder(f, finv, targets, xmin) {
  const xs = new Set();
  const add = (x) => {
    const v = Math.max(xmin, Math.round(x));
    if (Number.isFinite(v)) xs.add(v);
  };
  add(finv(0.8));
  for (const r of targets) {
    add(finv(r) / 1.08);
    add(finv(r) * 1.08);
  }
  const top = Math.max(...targets);
  add(finv(top + (1 - top) * 0.55));
  // Make sure every target is bracketed within the density rule; fall back to adjacent integers.
  for (const r of targets) {
    const arr = [...xs].sort((a, b) => a - b);
    const lo = arr.filter((v) => f(v) <= r).at(-1);
    const hi = arr.find((v) => f(v) >= r);
    if (lo === undefined || hi === undefined || (f(hi) - f(lo) > 0.02 && hi - lo !== 1)) {
      add(Math.floor(finv(r)));
      add(Math.ceil(finv(r)));
    }
  }
  // Fill the shape: no two consecutive knobs more than 1.9x apart (cap the length).
  let arr = [...xs].sort((a, b) => a - b);
  for (let guard = 0; guard < 8 && arr.length < 11; guard++) {
    let changed = false;
    for (let i = 0; i + 1 < arr.length; i++) {
      if (arr[i + 1] / arr[i] > 1.9 && arr[i + 1] - arr[i] > 1) {
        xs.add(Math.round(Math.sqrt(arr[i] * arr[i + 1])));
        changed = true;
      }
    }
    arr = [...xs].sort((a, b) => a - b);
    if (!changed) break;
  }
  return arr;
}

/** A ladder a participant has not tuned: doublings from the 0.80 anchor. */
function sparseLadder(f, finv, xmin) {
  const out = [];
  let x = Math.max(xmin, Math.round(finv(0.8)));
  for (let i = 0; i < 6 && f(x) < 0.9985; i++) {
    out.push(x);
    x *= 2;
  }
  out.push(x);
  return out;
}

function stats(sorted) {
  const n = sorted.length;
  const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.round((n - 1) * p)))];
  const avg = sorted.reduce((a, b) => a + b, 0) / n;
  return { n, min: sorted[0], avg, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted[n - 1] };
}

const roundStats = (s, d) => ({
  n: s.n, min: round(s.min, d), avg: round(s.avg, d), p50: round(s.p50, d), p95: round(s.p95, d), p99: round(s.p99, d), max: round(s.max, d),
});

/** One measured point in one view. */
function makePoint(p, ladderIndex, knobs, recall, qps32, view, clients, rand, fam, filter) {
  const qps = view === 'throughput' ? qps32 : qps32 / (32 * p.eff1);
  const avgMs = (clients / qps) * 1000;
  const shape = view === 'throughput' ? { min: 0.42, p50: 0.9, p95: 1.6, p99: 2.4, max: 8 } : { min: 0.7, p50: 0.93, p95: 1.55, p99: 2.3, max: 7 };
  const lat = {
    min: avgMs * shape.min * jitter(rand, 0.05), avg: avgMs, p50: avgMs * shape.p50 * jitter(rand, 0.03),
    p95: avgMs * shape.p95 * jitter(rand, 0.05), p99: avgMs * shape.p99 * jitter(rand, 0.08), max: avgMs * shape.max * jitter(rand, 0.2),
  };
  const passes = [];
  const nPasses = 3;
  for (let i = 0; i < nPasses; i++) {
    const q = qps * (i === 1 ? 1 : jitter(rand, 0.035) * 0.985);
    const duration = view === 'throughput' ? 2.0 : 4.0;
    passes.push({ qps: round(q, 1), avg: round((clients / q) * 1000, 3), p50: round(((clients / q) * 1000) * shape.p50, 3), p99: round(((clients / q) * 1000) * shape.p99, 3), queries: Math.round(q * duration), duration });
  }
  const best = passes.reduce((a, b) => (b.qps > a.qps ? b : a));
  const miss = 1 - recall;
  const tail = round(Math.min(0.5, miss * miss * (filter === 'xcorr' ? 24 : filter === 'none' ? 2 : 6)), 4);
  return {
    ladder_index: ladderIndex,
    knobs,
    recall: round(recall, 4),
    recall_strict: round(Math.max(0, recall - fam.strictGap * (1 + rand() * 0.3)), 4),
    tail,
    qps: best.qps,
    latency_ms: roundStats({ n: best.queries, ...lat, avg: (clients / best.qps) * 1000 }, 3),
    queries: best.queries,
    duration: best.duration,
    passes,
  };
}

/* ---- one result file ------------------------------------------------------- */

function makeResult(p, family, size) {
  const fam = famOf(family.family);
  const rows = family.sizes[size];
  const dataset = `${family.family}-${size}`;
  const langs = (family._source.langs ?? []).length || 7;
  const groups = [];
  const startups = [];

  // Distinct groups in query-list order, each with the recalls its rows ask for.
  const byKey = new Map();
  for (const q of family.queries) {
    const exact = q.recall === 'exact';
    const key = exact ? `exact/${q.filter}/${q.k}` : `${q.filter}/${q.k}`;
    if (!byKey.has(key)) byKey.set(key, { key, filter: q.filter, k: q.k, exact, targets: [] });
    if (!exact) byKey.get(key).targets.push(q.recall);
  }

  for (const g of byKey.values()) {
    const spec = family.filter_cases[g.filter] ?? {};
    const matches = matchesFor(spec, rows, langs);
    const degenerate = g.filter !== 'none' && matches < 10 * g.k;
    const unsupported = p.unsupportedFiltered && g.filter !== 'none';
    const errorReason = p.errorGroups?.[g.key];
    const { f, finv } = curveFor(p, g.filter, g.k, fam);
    let ladder = null;
    if (!g.exact) {
      ladder = p.sparseGroups?.includes(g.key) ? sparseLadder(f, finv, p.xmin) : designLadder(f, finv, g.targets, p.xmin);
      const cap = p.cappedGroups?.[g.key];
      if (cap !== undefined) {
        ladder = ladder.filter((x) => f(x) <= cap);
        ladder.push(Math.round(finv(cap)));
        ladder = [...new Set(ladder)].sort((a, b) => a - b);
      }
    }
    const qpsBase = p.qps0 * fam.qps * (p.kQps[g.k] ?? 1) * (p.filterQps[g.filter] ?? 1);
    const { h } = curveFor(p, g.filter, g.k, fam);
    for (const { view, clients } of VIEWS) {
      const rand = rng(`${p.participant}|${dataset}|${g.key}|${view}`);
      const base = { key: g.key, filter: g.filter, k: g.k, ...(g.exact ? { exact: true } : {}), view };
      if (unsupported) {
        groups.push({ ...base, status: 'unsupported' });
        continue;
      }
      if (degenerate) {
        groups.push({ ...base, status: 'n/a', reason: `degenerate: median ${matches} matching rows < ${10 * g.k}` });
        continue;
      }
      const startup = round(p.startupS * jitter(rand, 0.3), 2);
      startups.push(startup);
      const memBase = g.filter === 'none' ? p.memory.unfiltered : p.memory.filtered;
      const memory_peak = Math.round(memBase * fam.bytes * (0.9 + rand() * 0.08));
      if (errorReason) {
        groups.push({ ...base, clients, status: 'error', reason: errorReason, block: p.block(spec, family.metric, false), startup, memory_peak });
        continue;
      }
      const block = p.block(spec, family.metric, g.exact);
      const points = [];
      if (g.exact) {
        const qps32 = p.exactQps * fam.qps * (g.filter === 'none' ? 1 : p.exactFilteredBoost) * jitter(rand, 0.03);
        points.push(makePoint(p, 0, {}, 1.0, qps32, view, clients, rand, { ...fam, strictGap: fam.strictGap * 0.15 }, g.filter));
      } else {
        ladder.forEach((x, i) => {
          const recall = f(x) * (1 - 0.0008 * rand());
          const qps32 = (qpsBase / Math.pow(1 + x / h / p.decay.m, p.decay.alpha)) * jitter(rand, 0.02);
          points.push(makePoint(p, i, { [p.knob]: x }, recall, qps32, view, clients, rand, fam, g.filter));
        });
      }
      groups.push({ ...base, clients, status: 'ok', block, startup, memory_peak, points });
    }
  }

  const rand = rng(`${p.participant}|${dataset}|header`);
  const load_time = round(p.load.time * fam.load * jitter(rand, 0.04), 1);
  const load_phases = Object.fromEntries(Object.entries(p.load.phases).map(([k, v]) => [k, round(v * fam.load * jitter(rand, 0.04), 1)]));
  const disk_bytes = Math.round(p.disk.bytes * fam.bytes * jitter(rand, 0.03));
  const mem = (v) => (v == null ? null : Math.round(v * fam.bytes * jitter(rand, 0.03)));
  const startupSorted = [...startups].sort((a, b) => a - b);
  return {
    participant: p.participant,
    name: p.name,
    system: p.system,
    family: p.family,
    version: p.version,
    label: null,
    os: OS,
    date: DATE,
    dataset,
    tags: p.tags,
    hardware: HARDWARE,
    load_time,
    load_phases,
    disk_bytes,
    disk_info: p.disk.info(disk_bytes),
    memory_peak: { load: mem(p.memory.load), unfiltered: mem(p.memory.unfiltered), filtered: mem(p.memory.filtered) },
    startup: startupSorted.length ? roundStats(stats(startupSorted), 2) : null,
    index: { params: p.params, ddl: p.ddl(family.dims, family.metric) },
    groups,
    _source: `${p.participant}/results/${p.participant}_${dataset}.json`,
  };
}

/* ---- the page file ------------------------------------------------------------ */

export async function generateSample({ datasetsDir = DATASETS_DIR, size = SIZE } = {}) {
  const loaded = await loadFamilies(datasetsDir);
  const families = {};
  for (const [id, f] of Object.entries(loaded)) {
    const { _source, ...block } = f;
    void _source;
    families[id] = block;
  }
  const results = [];
  for (const id of Object.keys(loaded)) {
    for (const p of PARTICIPANTS) results.push(makeResult(p, loaded[id], size));
  }
  return { generated: GENERATED, sample: true, families, results };
}

export function serialize(page) {
  return JSON.stringify(page, null, 1) + '\n';
}

async function main() {
  const arg = process.argv[2];
  const page = await generateSample();
  const text = serialize(page);
  if (arg === '--stdout') {
    process.stdout.write(text);
    return;
  }
  const out = arg ? pathToFileURL(arg) : new URL('results.json', FRONTEND);
  await writeFile(out, text);
  const groups = page.results.reduce((n, r) => n + r.groups.length, 0);
  const points = page.results.reduce((n, r) => n + r.groups.reduce((m, g) => m + (g.points?.length ?? 0), 0), 0);
  console.log(`wrote ${fileURLToPath(out)}: ${Object.keys(page.families).length} families, ${page.results.length} result files, ${groups} groups, ${points} points, ${text.length} bytes (SYNTHETIC SAMPLE)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
