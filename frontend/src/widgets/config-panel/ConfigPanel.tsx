/* The view switches — searchbench's config panel with VectorBench's four rows:
   the load condition, how the grid is cut into rows, what a cell prints, and
   the statistic it reads. The last one depends on the first: the Throughput
   view reads queries per second and nothing else, so its strip is the one
   lit QPS button, and the Latency view offers every latency statistic. */

import type { Dispatch } from 'react';
import {
  LATENCY_METRICS,
  type BenchAction,
  type BenchState,
  type CellMode,
  type LatencyMetric,
  type RowMode,
  type View,
} from '../../shared/model';
import { Panel, SegRow, type SegOption } from '../../shared/ui';

const VIEW: readonly SegOption<View>[] = [
  { label: 'Throughput', v: 'throughput', title: '32 clients · queries per second, higher is better' },
  { label: 'Latency', v: 'latency', title: '1 client · milliseconds, lower is better' },
];
const ROWS: readonly SegOption<RowMode>[] = [
  {
    label: 'By group',
    v: 'groups',
    title: 'one row per group, every participant read at the strongest recall bar all of them reach, with each curve drawn in its cell',
  },
  {
    label: 'By recall bar',
    v: 'bars',
    title: 'the published reading: one row per (group, recall bar); a participant whose curve stops short of the bar reads as a word',
  },
];
const CELLS: readonly SegOption<CellMode>[] = [
  { label: 'Relative', v: 'relative', title: 'x1.00 = the row’s best; colour by ratio' },
  { label: 'Absolute', v: 'absolute', title: 'QPS as an integer, latency in ms' },
];
const LATENCY: readonly SegOption<LatencyMetric>[] = LATENCY_METRICS.map((m) => ({ label: m, v: m }));
const QPS: readonly SegOption<'qps'>[] = [{ label: 'QPS', v: 'qps', title: 'the Throughput view reads queries per second' }];

export function ConfigPanel({ state, dispatch }: { state: BenchState; dispatch: Dispatch<BenchAction> }) {
  return (
    <Panel>
      <div className="ph">
        <span className="pr">&gt;</span>
        <span className="pt">config</span>
        <span className="note" style={{ marginLeft: 'auto' }}>
          throughput: 32 clients, latency: 1
        </span>
      </div>
      <div style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <SegRow label="view" act="view" opts={VIEW} cur={state.view} onPick={(value) => dispatch({ type: 'view', value })} />
        <SegRow label="rows" act="row-mode" opts={ROWS} cur={state.rowMode} onPick={(value) => dispatch({ type: 'row-mode', value })} />
        <SegRow label="cells" act="cells" opts={CELLS} cur={state.cells} onPick={(value) => dispatch({ type: 'cells', value })} />
        {/* Six labels in the column, hence searchbench's tighter padding and
            half-pixel-smaller face for its three-label row. */}
        {state.view === 'throughput' ? (
          <SegRow label="metric" act="metric-qps" opts={QPS} cur="qps" onPick={() => undefined} />
        ) : (
          <SegRow
            label="metric"
            act="metric"
            opts={LATENCY}
            cur={state.latencyMetric}
            pad="4px 2px"
            fs="10.5px"
            onPick={(value) => dispatch({ type: 'metric', value })}
          />
        )}
      </div>
    </Panel>
  );
}
