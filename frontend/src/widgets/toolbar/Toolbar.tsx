/* The top bar of DESIGN.md section 2: dataset family and size, view, cells,
   the latency statistic, and below them the chips that filter rows by tag.
   Scores and coverage recompute over the visible rows, which is why every chip
   carries a title saying so. */

import type { Dispatch } from 'react';
import {
  CHIP_DIMENSIONS,
  allChipTags,
  chipLabel,
  chipTag,
  defaultDatasetOfFamily,
  type Benchmark,
  type DatasetModel,
} from '../../entities/results';
import { fmtBytes, fmtInt } from '../../shared/lib/format';
import { LATENCY_METRICS, VIEWS, VIEW_LABELS, type BenchAction, type BenchState, type CellMode, type LatencyMetric, type View } from '../../shared/model';
import { Labeled, Panel, Seg, type SegOption } from '../../shared/ui';

const CELLS: readonly SegOption<CellMode>[] = [
  { label: 'relative', v: 'relative', title: 'x1.00 = the row’s best; colour by ratio' },
  { label: 'absolute', v: 'absolute', title: 'QPS as an integer, latency in ms' },
];
const VIEW_OPTS: readonly SegOption<View>[] = VIEWS.map((v) => ({ label: VIEW_LABELS[v], v }));
const METRIC_OPTS: readonly SegOption<LatencyMetric>[] = LATENCY_METRICS.map((m) => ({ label: m, v: m }));
const QPS_OPT: readonly SegOption<'qps'>[] = [{ label: 'QPS', v: 'qps', title: 'the Throughput view reads queries per second' }];

const CHIP_TITLES: Record<(typeof CHIP_DIMENSIONS)[number], string> = {
  filter: 'show only rows with this filter case — scores and coverage recompute',
  k: 'show only rows with this k — scores and coverage recompute',
  recall: 'show only rows at this recall — scores and coverage recompute',
};

/** The hardware tier every result of the dataset was run on, or a note that they differ. */
function tierOf(dataset: DatasetModel): string {
  const tiers = new Set(
    dataset.results.map((r) => {
      const h = r.raw.hardware;
      return h ? `${h.cpus} CPUs · ${fmtBytes(h.memory_bytes)} · ${h.storage}` : 'unknown tier';
    }),
  );
  return tiers.size === 1 ? [...tiers][0] : 'mixed tiers (see column tooltips)';
}

export function Toolbar({
  bench,
  dataset,
  state,
  dispatch,
}: {
  bench: Benchmark;
  dataset: DatasetModel;
  state: BenchState;
  dispatch: Dispatch<BenchAction>;
}) {
  const family = dataset.family;
  const families: SegOption<string>[] = bench.families
    .filter((f) => bench.datasets.some((d) => d.family === f))
    .map((f) => ({ label: f.id, v: f.id, title: f.title }));
  const sizes: SegOption<string>[] = family.sizes.map((s) => {
    const id = `${family.id}-${s.name}`;
    const has = bench.datasets.some((d) => d.id === id);
    return { label: s.name, v: s.name, disabled: !has, title: has ? `${fmtInt(s.rows)} rows` : 'no results at this size yet' };
  });
  const pick = (id: string | null) => {
    if (id) dispatch({ type: 'dataset', id, tags: allChipTags(bench.datasets.find((d) => d.id === id)!) });
  };

  return (
    <Panel>
      <div className="ph">
        <span className="pr">&gt;</span>
        <span className="pt">config</span>
        <span className="note" style={{ marginLeft: 'auto', fontSize: 10.5 }}>
          {family.title} · {family.dims}-d · {family.metric} · {fmtInt(dataset.rows)} rows · {tierOf(dataset)}
          {bench.generated ? ` · assembled ${bench.generated.slice(0, 10)}` : ''}
        </span>
      </div>
      <div className="toolbar">
        <Labeled label="dataset">
          <Seg act="family" opts={families} cur={family.id} onPick={(id) => pick(defaultDatasetOfFamily(bench, id))} />
          <Seg act="size" opts={sizes} cur={dataset.size} onPick={(size) => pick(`${family.id}-${size}`)} />
        </Labeled>
        <Labeled label="view">
          <Seg act="view" opts={VIEW_OPTS} cur={state.view} onPick={(value) => dispatch({ type: 'view', value })} />
        </Labeled>
        <Labeled label="cells">
          <Seg act="cells" opts={CELLS} cur={state.cells} onPick={(value) => dispatch({ type: 'cells', value })} />
        </Labeled>
        <Labeled label="metric">
          {state.view === 'throughput' ? (
            <Seg act="metric-qps" opts={QPS_OPT} cur="qps" onPick={() => undefined} />
          ) : (
            <Seg act="metric" opts={METRIC_OPTS} cur={state.latencyMetric} onPick={(value) => dispatch({ type: 'metric', value })} />
          )}
        </Labeled>
      </div>
      <div className="chips">
        {CHIP_DIMENSIONS.map((dim) => (
          <span key={dim} style={{ display: 'contents' }}>
            <span className="cl" style={dim === 'k' ? { textTransform: 'none' } : undefined}>
              {dim}
            </span>
            {family.chips[dim].map((v) => {
              const tag = chipTag(dim, v);
              return (
                <button
                  key={tag}
                  type="button"
                  className={state.chips.has(tag) ? 'chip on' : 'chip'}
                  data-act="chip"
                  data-tag={tag}
                  title={CHIP_TITLES[dim]}
                  onClick={() => dispatch({ type: 'chip', tag })}
                >
                  {chipLabel(dim, v)}
                </button>
              );
            })}
          </span>
        ))}
        {state.chips.size > 0 && (
          <button type="button" className="link" style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--accent)', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }} data-act="clear-chips" onClick={() => dispatch({ type: 'clear-chips' })}>
            clear chips
          </button>
        )}
      </div>
    </Panel>
  );
}
