/* The page's data model on the synthetic sample: the generator is run into
   memory (never the committed results.json, which `vectorbench assemble` will
   replace), the benchmark is built the way dataset.ts builds it, and the cells,
   scores, coverage and column order are checked against what contracts
   sections 9–11 say they must be. Node strips the types itself. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSample, serialize } from '../scripts/sample-results.mjs';
import { buildBenchmark, ContractError, groupKey, splitDatasetId } from '../src/entities/results/model/model.ts';
import { computeGrid, gridCell, failLabel, groupFor, metricFor } from '../src/entities/results/model/cells.ts';
import { cellValue } from '../src/entities/results/model/frontier.ts';
import { orderResults, ratioTo, sectionScores } from '../src/entities/results/model/scores.ts';
import { allChipTags, chipTag, visibleRows } from '../src/entities/results/model/rows.ts';
import { INITIAL_STATE } from '../src/shared/model/state.ts';
import { restoreUrlState, shortState } from '../src/shared/model/url-codec.ts';
import { readingSize, screenRows, tickedRows } from '../src/pages/bench/model/selection.ts';

const page = await generateSample();
const bench = buildBenchmark(page);

const dataset = (id) => bench.datasets.find((d) => d.id === id);
const result = (ds, pid) => ds.results.find((r) => r.id === pid);
const row = (ds, qid) => ds.family.queries.find((q) => q.id === qid);
const cellOf = (grid, qid, pid) => gridCell(grid, qid, pid);

test('the sample follows section 11 and is deterministic', async () => {
  assert.deepEqual(Object.keys(page).sort(), ['families', 'generated', 'results', 'sample']);
  assert.equal(page.sample, true);
  assert.deepEqual(Object.keys(page.families), ['sift-128', 'wiki-v3-1024']); // the assembler's alphabetical order
  for (const f of Object.values(page.families)) {
    assert.deepEqual(Object.keys(f), ['family', 'title', 'description', 'dims', 'metric', 'sizes', 'filter_cases', 'queries']);
    assert.ok(f.queries.length >= 37);
  }
  assert.equal(page.results.length, 8);
  for (const r of page.results) {
    for (const key of ['participant', 'name', 'system', 'family', 'version', 'label', 'os', 'date', 'dataset', 'tags', 'hardware', 'load_time', 'load_phases', 'disk_bytes', 'disk_info', 'memory_peak', 'startup', 'index', 'groups', '_source']) {
      assert.ok(key in r, `${r.participant}: missing ${key}`);
    }
    assert.equal(r._source, `${r.participant}/results/${r.participant}_${r.dataset}.json`);
    const seen = new Set();
    for (const g of r.groups) {
      const k = g.view + '|' + g.key;
      assert.ok(!seen.has(k), `${r.participant}: duplicate group ${k}`);
      seen.add(k);
      assert.ok(['ok', 'unsupported', 'n/a', 'error'].includes(g.status));
      if (g.status === 'ok') {
        assert.ok(g.points.length >= 1);
        assert.ok(typeof g.block === 'string');
        for (const p of g.points) {
          assert.ok(p.recall > 0 && p.recall <= 1);
          assert.ok(p.qps > 0);
          for (const s of ['n', 'min', 'avg', 'p50', 'p95', 'p99', 'max']) assert.ok(typeof p.latency_ms[s] === 'number');
          assert.ok(Array.isArray(p.passes) && p.passes.length >= 1);
        }
        if (g.exact) {
          assert.equal(g.points.length, 1);
          assert.equal(g.points[0].recall, 1);
          assert.deepEqual(g.points[0].knobs, {});
        }
      }
    }
  }
  const again = await generateSample();
  assert.equal(serialize(again), serialize(page));
});

test('datasets, participants and the default dataset', () => {
  assert.deepEqual(bench.datasets.map((d) => d.id), ['sift-128-100k', 'wiki-v3-1024-100k']);
  assert.deepEqual(bench.participants.map((p) => p.id), ['pgvector-hnsw', 'qdrant-hnsw', 'serenedb-hnsw', 'serenedb-ivf']);
  assert.equal(bench.defaultDataset, 'sift-128-100k'); // first family in file order, the one size everyone ran
  assert.deepEqual(splitDatasetId('wiki-v3-1024-100k'), ['wiki-v3-1024', '100k']);
  assert.equal(splitDatasetId('nonsense'), null);
  assert.equal(groupKey('eq-1', 10, true), 'exact/eq-1/10');
  const wiki = dataset('wiki-v3-1024-100k');
  assert.equal(wiki.results.length, 4);
  assert.deepEqual(wiki.family.chips, {
    filter: ['none', 'eq', 'range', 'and', 'corr', 'xcorr', 'lang', 'xlang'],
    k: ['10', '100', '1000'],
    recall: ['0.9', '0.95', '0.99', 'exact'],
  });
  const v11 = row(wiki, 'V11');
  assert.equal(v11.key, 'eq-10/10');
  assert.equal(v11.section, 'filtered');
  assert.deepEqual(v11.tags, ['filter:eq', 'k:10', 'recall:0.95']);
  assert.equal(row(wiki, 'V37').key, 'exact/eq-1/10');
  assert.equal(row(wiki, 'V01').section, 'nofilter');
  // colours: SereneDB participants on the blue ramp, others on the palette, all distinct
  assert.equal(new Set(bench.colors.values()).size, 4);
  assert.ok(bench.colors.get('serenedb-ivf').startsWith('#') && bench.colors.get('serenedb-hnsw') !== bench.colors.get('serenedb-ivf'));
});

test('cells: statuses from the sample, both views', () => {
  const wiki = dataset('wiki-v3-1024-100k');
  const grid = computeGrid(wiki, 'throughput', 'qps');
  // SereneDB HNSW: every filtered row unsupported, no-filter rows fine
  for (const q of wiki.family.queries) {
    const c = cellOf(grid, q.id, 'serenedb-hnsw');
    if (q.section === 'filtered') assert.equal(c.status, 'unsupported', q.id);
    else assert.ok(cellValue(c) !== null, `${q.id}: ${c.status}`);
  }
  // pgvector never reaches 0.99 on none/10
  const v03 = cellOf(grid, 'V03', 'pgvector-hnsw');
  assert.equal(v03.status, 'not_reached');
  assert.equal(failLabel(v03), 'reached 0.97');
  // Qdrant's sparse xcorr/10 ladder fails the density rule at 0.95 but brackets 0.99
  assert.equal(failLabel(cellOf(grid, 'V32', 'qdrant-hnsw')), 'bracket too wide');
  assert.equal(cellOf(grid, 'V36', 'qdrant-hnsw').status, 'interpolated');
  // the degenerate rule at 100k: eq-0.1 has ~100 matching rows, so k=100 and k=1000 are n/a for everyone
  for (const pid of ['serenedb-ivf', 'qdrant-hnsw', 'pgvector-hnsw']) {
    assert.equal(cellOf(grid, 'V18', pid).status, 'n/a', pid);
    assert.equal(cellOf(grid, 'V19', pid).status, 'n/a', pid);
    assert.match(cellOf(grid, 'V19', pid).reason, /degenerate/);
  }
  assert.equal(cellOf(grid, 'V13', 'pgvector-hnsw').status, 'error');
  // exact rows read the brute-force point
  const v04 = cellOf(grid, 'V04', 'serenedb-ivf');
  assert.equal(v04.status, 'point');
  assert.equal(v04.point.recall, 1);
  assert.deepEqual(v04.point.knobs, {});
  // an interpolated cell lies between its bracketing points, qps falling with recall
  const v02 = cellOf(grid, 'V02', 'serenedb-ivf');
  assert.equal(v02.status, 'interpolated');
  assert.ok(v02.a.recall < 0.95 && v02.b.recall > 0.95);
  assert.ok(v02.value < v02.a.value && v02.value > v02.b.value);
  // the latency view reads the latency statistic, lower is better
  const lat = computeGrid(wiki, 'latency', metricFor('latency', 'p50'));
  assert.equal(lat.direction, 'lower');
  const l02 = cellOf(lat, 'V02', 'serenedb-ivf');
  assert.equal(l02.status, 'interpolated');
  assert.ok(l02.value > l02.a.value && l02.value < l02.b.value);
  assert.ok(lat.best.get('V02') <= l02.value);
  assert.ok(grid.best.get('V02') >= v02.value);
});

test('scores and coverage (section 10) and the column order', () => {
  const wiki = dataset('wiki-v3-1024-100k');
  const grid = computeGrid(wiki, 'throughput', 'qps');
  const rows = wiki.family.queries;
  const nf = sectionScores(grid, wiki.results, rows.filter((r) => r.section === 'nofilter'), 'nofilter');
  const fi = sectionScores(grid, wiki.results, rows.filter((r) => r.section === 'filtered'), 'filtered');
  // coverage = ok rows / visible rows
  assert.deepEqual(nf.coverage.get('pgvector-hnsw'), { ok: 9, total: 10 });
  assert.deepEqual(nf.coverage.get('serenedb-ivf'), { ok: 10, total: 10 });
  assert.deepEqual(fi.coverage.get('serenedb-hnsw'), { ok: 0, total: 29 });
  assert.equal(fi.score.get('serenedb-hnsw'), null);
  // the best participant of a section with full coverage scores exactly 1 when it is the best in every row
  const best = orderResults(wiki.results, nf)[0];
  assert.equal(nf.coverage.get(best.id).ok, 10);
  for (const r of wiki.results) {
    const s = nf.score.get(r.id);
    if (s !== null) assert.ok(s >= 1 - 1e-12, `${r.id} scores ${s}`);
  }
  // the score is the geomean of ratios to the row's best over the rows the participant is ok on
  const pid = 'qdrant-hnsw';
  let logSum = 0;
  let n = 0;
  for (const q of rows.filter((r) => r.section === 'nofilter')) {
    const v = cellValue(cellOf(grid, q.id, pid));
    if (v === null) continue;
    logSum += Math.log(ratioTo(v, grid.best.get(q.id), 'higher'));
    n++;
  }
  assert.ok(Math.abs(nf.score.get(pid) - Math.exp(logSum / n)) < 1e-12);
  // order: coverage descending, then score ascending
  const order = orderResults(wiki.results, fi).map((r) => r.id);
  const covs = order.map((id) => fi.coverage.get(id).ok);
  for (let i = 1; i < covs.length; i++) {
    assert.ok(covs[i - 1] >= covs[i]);
    if (covs[i - 1] === covs[i]) assert.ok((fi.score.get(order[i - 1]) ?? Infinity) <= (fi.score.get(order[i]) ?? Infinity));
  }
  assert.equal(order.at(-1), 'serenedb-hnsw'); // supports nothing filtered
  // chips narrow the rows and the scores recompute over them
  const k10 = visibleRows(wiki.queries, new Set([chipTag('k', '10')]));
  assert.ok(k10.length > 0 && k10.every((q) => q.k === 10));
  const both = visibleRows(wiki.queries, new Set([chipTag('k', '10'), chipTag('recall', 'exact')]));
  assert.deepEqual(both.map((q) => q.id), ['V04', 'V37']);
  const or = visibleRows(wiki.queries, new Set([chipTag('recall', '0.9'), chipTag('recall', '0.99')]));
  assert.ok(or.every((q) => q.recall === 0.9 || q.recall === 0.99));
  const narrowed = sectionScores(grid, wiki.results, k10.filter((r) => r.section === 'filtered'), 'filtered');
  assert.equal(narrowed.coverage.get('serenedb-ivf').total, k10.filter((r) => r.section === 'filtered').length);
});

test('the loader is strict to the contract', () => {
  assert.throws(() => buildBenchmark(null), ContractError);
  assert.throws(() => buildBenchmark({ families: {}, results: 'no' }), ContractError);
  assert.throws(() => buildBenchmark({ families: {}, results: [{ dataset: 'wiki-v3-1024-100k', participant: 'x', name: 'X', groups: [] }] }), /no family definition/);
  const fam = page.families['sift-128'];
  assert.throws(() => buildBenchmark({ families: { 'sift-128': fam }, results: [{ dataset: 'sift-128-5m', participant: 'x', name: 'X', groups: [] }] }), /size 5m/);
  assert.throws(() => buildBenchmark({ families: { 'sift-128': fam }, results: [{ dataset: 'sift-128-100k', participant: 'x', name: 'X', groups: [{ key: 'none/10', view: 'both', status: 'ok' }] }] }), /view/);
  assert.throws(() => buildBenchmark({ families: { 'sift-128': { ...fam, queries: [{ id: 'V01', filter: 'nope', k: 10, recall: 0.9 }] } }, results: [] }), /unknown filter case/);
  assert.throws(() => buildBenchmark({ families: { 'sift-128': { ...fam, queries: [{ id: 'V01', filter: 'none', k: 10, recall: 1.5 }] } }, results: [] }), /recall/);
  const r = page.results[0];
  assert.throws(() => buildBenchmark({ families: page.families, results: [r, r] }), /two result files/);
  // an empty benchmark is valid: no datasets, no default
  const empty = buildBenchmark({ generated: '', families: page.families, results: [] });
  assert.equal(empty.datasets.length, 0);
  assert.equal(empty.defaultDataset, null);
});

test('URL codec round-trips the selectors and chips', () => {
  const env = {
    datasets: bench.datasets.map((d) => d.id),
    defaultDataset: bench.defaultDataset,
    tagsFor: (id) => allChipTags(dataset(id)),
    rowsFor: (id) => new Set(dataset(id).family.queries.flatMap((q) => [q.id, q.key])),
    participants: bench.participants.map((p) => p.id),
  };
  assert.deepEqual(shortState(INITIAL_STATE, env, 'light'), { v: 1 });
  const state = {
    ...INITIAL_STATE,
    dataset: 'wiki-v3-1024-100k',
    view: 'latency',
    latencyMetric: 'p99',
    cells: 'absolute',
    rowMode: 'bars',
    chips: new Set(['k:10', 'filter:eq']),
    sortSection: 'filtered',
    graphRows: ['V14', 'V35'],
    hidden: new Set(['serenedb-hnsw', 'pgvector-hnsw']),
  };
  const packed = shortState(state, env, 'dark');
  assert.deepEqual(packed, { v: 1, d: 'wiki-v3-1024-100k', t: 'latency', m: 'p99', c: 'absolute', rm: 'bars', q: 'filter:eq,k:10', h: 'pgvector-hnsw,serenedb-hnsw', s: 'filtered', g: 'V14,V35', th: 'dark' });
  assert.deepEqual(Object.keys(packed), ['v', 'd', 't', 'm', 'c', 'rm', 'q', 'h', 's', 'g', 'th'], 'key order is the wire format');
  const b64 = Buffer.from(JSON.stringify(packed)).toString('base64url');
  const { patch, theme } = restoreUrlState('?s=' + b64, env, INITIAL_STATE);
  assert.equal(theme, 'dark');
  assert.equal(patch.dataset, 'wiki-v3-1024-100k');
  assert.equal(patch.view, 'latency');
  assert.equal(patch.latencyMetric, 'p99');
  assert.equal(patch.cells, 'absolute');
  assert.equal(patch.rowMode, 'bars');
  assert.deepEqual([...patch.chips].sort(), ['filter:eq', 'k:10']);
  assert.equal(patch.sortSection, 'filtered');
  assert.deepEqual(patch.graphRows, ['V14', 'V35']);
  assert.deepEqual([...patch.hidden].sort(), ['pgvector-hnsw', 'serenedb-hnsw']);
  // readable overrides win, unknown values fall back, unknown chips and rows are dropped
  const o = restoreUrlState('?s=' + b64 + '&view=throughput&rows=sideways&chips=k:10,bogus:1&graph=V14,V99&dataset=nope&hidden=nobody,qdrant-hnsw', env, INITIAL_STATE);
  assert.deepEqual([...o.patch.hidden], ['qdrant-hnsw'], 'unknown participants are dropped');
  assert.equal(o.patch.view, 'throughput');
  assert.equal(o.patch.rowMode, 'groups');
  assert.deepEqual([...o.patch.chips], ['k:10']);
  assert.deepEqual(o.patch.graphRows, ['V14']);
  assert.equal(o.patch.dataset, undefined);
  assert.equal(o.patch.dataset ?? env.defaultDataset, 'sift-128-100k');

  // Nothing picked yet writes nothing; everything unticked is written, and read back.
  assert.deepEqual(shortState({ ...INITIAL_STATE, graphRows: [] }, env, 'light'), { v: 1, g: '-' });
  assert.deepEqual(restoreUrlState('?graph=-', env, INITIAL_STATE).patch.graphRows, []);
  assert.equal(restoreUrlState('?graph=', env, INITIAL_STATE).patch.graphRows, null);
  // Group keys are row ids too, and the row a link opened under the table
  // before the graph moved beside it stays ticked.
  const key = row(dataset('sift-128-100k'), 'V14').key;
  assert.deepEqual(restoreUrlState(`?graph=${encodeURIComponent(key)}&row=V02`, env, INITIAL_STATE).patch.graphRows, [key, 'V02']);
  assert.deepEqual(restoreUrlState('?row=V02&expanded=1', env, INITIAL_STATE).patch.graphRows, ['V02']);
});

test('the ticked rows, read in either reading', () => {
  const ds = dataset('sift-128-100k');
  const groupsOnScreen = screenRows(ds.queries, 'groups');
  const barsOnScreen = screenRows(ds.queries, 'bars');
  assert.equal(groupsOnScreen.length, readingSize(ds, 'groups'));
  assert.equal(barsOnScreen.length, readingSize(ds, 'bars'));
  assert.ok(groupsOnScreen.length < barsOnScreen.length, 'a group folds its bars');
  // sections first: the table lists NO FILTER above FILTERED
  const sectionOf = (id) => ds.queries.find((q) => q.id === id).section;
  const firstFiltered = barsOnScreen.findIndex((id) => sectionOf(id) === 'filtered');
  assert.ok(barsOnScreen.slice(firstFiltered).every((id) => sectionOf(id) === 'filtered'));

  // one block per filter case, its rows by k: a case's extra bars listed at the
  // end of the family join its block
  const caseOf = (id) => ds.queries.find((q) => q.id === id);
  const seen = new Set();
  let prev = null;
  for (const id of barsOnScreen) {
    const q = caseOf(id);
    const block = q.section + '|' + q.filter;
    if (block !== prev?.block) {
      assert.ok(!seen.has(block), `${block} is one block`);
      seen.add(block);
    } else {
      assert.ok(q.k >= prev.k, `${id}: k never falls inside a block`);
    }
    prev = { block, k: q.k };
  }

  // nothing picked yet: the first row on screen
  assert.deepEqual(tickedRows(null, 'groups', ds, groupsOnScreen), [groupsOnScreen[0]]);
  assert.deepEqual(tickedRows(null, 'bars', ds, []), []);
  // a bar stands for its group, a group for its bars
  const v14 = row(ds, 'V14');
  const bars = ds.queries.filter((q) => q.key === v14.key).map((q) => q.id);
  assert.deepEqual(tickedRows(['V14'], 'groups', ds, groupsOnScreen), [v14.key]);
  assert.deepEqual(tickedRows([v14.key], 'bars', ds, barsOnScreen), bars);
  assert.deepEqual(tickedRows([...bars, v14.key], 'groups', ds, groupsOnScreen), [v14.key], 'one group, however it was ticked');
  assert.deepEqual(tickedRows(['nope'], 'bars', ds, barsOnScreen), []);
  // rows the chips hide stay ticked: unticking happens in the table
  const onlyK10 = screenRows(visibleRows(ds.queries, new Set([chipTag('k', '10')])), 'bars');
  const hiddenRow = barsOnScreen.find((id) => !onlyK10.includes(id));
  assert.deepEqual(tickedRows([hiddenRow], 'bars', ds, onlyK10), [hiddenRow]);
});

test('latency is read where the run put it', () => {
  // The sample has latency runs: the Latency view reads them, one client.
  const ds = dataset('sift-128-100k');
  assert.deepEqual(ds.latency, { from: 'latency', clients: 1 });

  // Without any latency run on a dataset, the throughput run's per-query latencies stand in,
  // under its clients, for every participant of the dataset.
  const throughputOnly = {
    ...page,
    results: page.results
      .filter((r) => r.dataset === 'sift-128-100k')
      .map((r) => ({ ...r, groups: r.groups.filter((g) => g.view === 'throughput') })),
  };
  const b = buildBenchmark(throughputOnly);
  const d = b.datasets.find((x) => x.id === 'sift-128-100k');
  assert.equal(d.latency.from, 'throughput');
  assert.equal(d.latency.clients, d.results[0].raw.groups[0].clients ?? null);
  const r = d.results[0];
  const q = d.queries.find((x) => groupFor(r, x, 'throughput')?.status === 'ok');
  assert.equal(groupFor(r, q, 'latency'), groupFor(r, q, 'throughput'), 'the throughput group stands as the latency group');
  const grid = computeGrid(d, 'latency', metricFor('latency', 'p50'));
  assert.ok([...grid.cells.values()].some((c) => typeof c.value === 'number'), 'the Latency view has numbers');

  // Nothing records latency: no view to read it in.
  const noLatency = {
    ...throughputOnly,
    results: throughputOnly.results.map((r) => ({
      ...r,
      groups: r.groups.map((g) => ({ ...g, points: (g.points ?? []).map(({ latency_ms, ...pt }) => pt) })),
    })),
  };
  assert.equal(buildBenchmark(noLatency).datasets.find((x) => x.id === 'sift-128-100k').latency, null);
});
