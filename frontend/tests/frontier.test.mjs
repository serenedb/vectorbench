/* Every case of lib/vectorbench/testdata/frontier_cases.json against the
   TypeScript frontier (contracts section 9). The Python driver runs the same
   file in tests/test_frontier.py; both must pass or the table and the driver
   would read a curve differently. Node strips the types itself. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { adjacentInt, cell, crossing, dominated, frontier, toPoints } from '../src/entities/results/model/frontier.ts';

const CASES = JSON.parse(
  await readFile(new URL('../../lib/vectorbench/testdata/frontier_cases.json', import.meta.url), 'utf8'),
).cases;

const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-300), `${a} != ${b}`);

for (const c of CASES) {
  test(`frontier: ${c.name}`, () => {
    const got = crossing(toPoints(c.points, (p) => p.value), c.direction, c.r);
    const exp = c.expect;
    assert.equal(got.status, exp.status);
    if ('value' in exp) close(got.value, exp.value);
    if ('reached' in exp) close(got.reached, exp.reached, 1e-9);
    if ('gap' in exp) close(got.gap, exp.gap);
    if ('a_recall' in exp) {
      close(got.a.recall, exp.a_recall, 1e-9);
      close(got.b.recall, exp.b_recall, 1e-9);
    }
  });
}

test('frontier keeps strictly better points only and re-sorts by recall', () => {
  const pts = toPoints(
    [
      { recall: 0.9, value: 100, knobs: {} },
      { recall: 0.9, value: 100, knobs: {} }, // duplicate: dropped
      { recall: 0.95, value: 100, knobs: {} }, // dominates both 0.9 points (same value, more recall)
      { recall: 0.8, value: 200, knobs: {} },
    ],
    (p) => p.value,
  );
  const front = frontier(pts, 'higher');
  assert.deepEqual(front.map((p) => [p.recall, p.value]), [[0.8, 200], [0.95, 100]]);
  assert.deepEqual(dominated(pts, 'higher').map((p) => p.index), [0, 1]);
});

test('adjacent on the ladder: the same knobs, one integer knob apart by one', () => {
  const p = (knobs) => ({ recall: 0.9, value: 1, knobs, index: 0 });
  assert.ok(adjacentInt(p({ nprobe: 4 }), p({ nprobe: 5 })));
  assert.ok(!adjacentInt(p({ nprobe: 4 }), p({ ef: 5 })));
  assert.ok(adjacentInt(p({ nprobe: 4, rerank: 2 }), p({ nprobe: 5, rerank: 2 })));
  assert.ok(!adjacentInt(p({ nprobe: 4, rerank: 2 }), p({ nprobe: 5, rerank: 3 })));
  assert.ok(!adjacentInt(p({ nprobe: 4, mode: 'auto' }), p({ nprobe: 4, mode: 'bridge' })));
  assert.ok(!adjacentInt(p({ nprobe: 4.5 }), p({ nprobe: 5.5 })));
  assert.ok(!adjacentInt(p({ nprobe: '4' }), p({ nprobe: '5' })));
  assert.ok(!adjacentInt(p({}), p({})));
});

test('cell(): group statuses, exact rows and the metric picker', () => {
  const point = (recall, qps, p50, knobs) => ({
    ladder_index: 0, knobs, recall, recall_strict: recall, tail: 0,
    qps, latency_ms: { n: 1, min: p50, avg: p50, p50, p95: p50, p99: p50, max: p50 },
  });
  const ok = {
    key: 'none/10', filter: 'none', k: 10, view: 'throughput', status: 'ok',
    points: [point(0.94, 1000, 1.0, { ef: 32 }), point(0.96, 600, 2.0, { ef: 64 })],
  };
  assert.equal(cell(undefined, 'qps', 0.95).status, 'unsupported');
  assert.deepEqual(cell({ ...ok, status: 'n/a', reason: 'degenerate' }, 'qps', 0.95), { status: 'n/a', reason: 'degenerate' });
  assert.deepEqual(cell({ ...ok, status: 'error', reason: 'boom' }, 'qps', 0.95), { status: 'error', reason: 'boom' });
  assert.deepEqual(cell({ ...ok, status: 'weird' }, 'qps', 0.95), { status: 'error', reason: null });
  const c = cell(ok, 'qps', 0.95);
  assert.equal(c.status, 'interpolated');
  const l = cell(ok, 'p50', 0.95);
  assert.equal(l.status, 'interpolated');
  // log-linear between 1.0 ms and 2.0 ms, half way
  close(l.value, Math.SQRT2);
  close(c.value, Math.sqrt(1000 * 600));
  assert.equal(cell(ok, 'qps', 0.99).status, 'not_reached');
  assert.equal(cell(ok, 'qps', 0.5).status, 'above');
  const exact = { ...ok, key: 'exact/none/10', exact: true, points: [point(1.0, 410, 70, {})] };
  assert.deepEqual(cell(exact, 'qps', 'exact'), { status: 'point', value: 410, point: { recall: 1, value: 410, knobs: {}, index: 0 } });
  assert.deepEqual(cell({ ...exact, points: [] }, 'qps', 'exact'), { status: 'none' });
  assert.deepEqual(cell({ ...ok, points: [point(null, 100, 1, { ef: 1 })] }, 'qps', 0.9), { status: 'none' });
});
