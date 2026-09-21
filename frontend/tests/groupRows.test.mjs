/* The per-group reading (groupRows.ts) against the committed results.json:
   every group must produce a bar every live participant can be read at, so the
   row has numbers where the bar-per-row reading had words. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildBenchmark } from '../src/entities/results/model/model.ts';
import { groupRows } from '../src/entities/results/model/groupRows.ts';
import { directionOf } from '../src/entities/results/model/cells.ts';

const page = JSON.parse(await readFile(new URL('../results.json', import.meta.url), 'utf8'));
const bench = buildBenchmark(page);

test('every group yields a readable number for every participant that has a curve', () => {
  for (const ds of bench.datasets) {
    for (const view of ['throughput', 'latency']) {
      const metric = view === 'throughput' ? 'qps' : 'p50';
      const rows = groupRows(ds, view, metric, directionOf(metric));
      for (const r of rows) {
        for (const c of r.curves) {
          if (c.reach === null) continue; // no curve at all: genuinely unsupported
          assert.notEqual(c.value, null, `${ds.id} ${view} ${r.key} ${c.pid}: curve reaches ${c.reach} but no value at bar ${r.bar}`);
        }
      }
    }
  }
});

test('the bar never exceeds any live participant\'s reach', () => {
  for (const ds of bench.datasets) {
    const rows = groupRows(ds, 'throughput', 'qps', 'higher');
    for (const r of rows) {
      if (r.bar === null) continue;
      for (const c of r.curves) {
        if (c.reach === null) continue;
        assert.ok(c.reach + 1e-9 >= r.bar, `${ds.id} ${r.key} ${c.pid}: reach ${c.reach} < bar ${r.bar}`);
      }
    }
  }
});
