/* The strip under the title bar: what a reader changes while comparing sits in
   plain sight, the rest is one click away. The dataset, the load condition and
   — in the Latency view — the statistic are in the strip; the row chips and the
   participants wait behind Filter, how the grid is cut and printed behind
   Display. While those menus are closed the strip still says what they hold
   that is on: a count on Filter, and a pill per chip or hidden participant,
   each removable with a click. */

import type { Dispatch, ReactNode } from 'react';
import { allChipTags, chipLabel, type Benchmark, type ChipDimension, type DatasetModel, type ResultModel } from '../../entities/results';
import { LATENCY_METRICS, type BenchAction, type BenchState, type LatencyMetric, type View } from '../../shared/model';
import { Dropdown, Seg, type SegOption } from '../../shared/ui';
import { DatasetLabel, DatasetMenu } from './DatasetMenu';
import { DisplayMenu } from './DisplayMenu';
import { FilterMenu } from './FilterMenu';

const VIEW: readonly SegOption<View>[] = [
  { label: 'Throughput', v: 'throughput', title: '32 clients · queries per second, higher is better' },
  { label: 'Latency', v: 'latency', title: '1 client · milliseconds, lower is better' },
];
const LATENCY: readonly SegOption<LatencyMetric>[] = LATENCY_METRICS.map((m) => ({ label: m, v: m, title: `the ${m} of one client's latencies, ms` }));

/** A pill names its dimension where the chip alone would not: `eq` is a filter, `0.95` a recall. */
function pillText(tag: string): string {
  const i = tag.indexOf(':');
  const dim = tag.slice(0, i) as ChipDimension;
  const label = chipLabel(dim, tag.slice(i + 1));
  return dim === 'k' ? label : `${dim} ${label}`;
}

export function Toolbar({
  bench,
  dataset,
  everyone,
  state,
  dispatch,
}: {
  bench: Benchmark;
  /** The dataset on screen, every participant included. */
  dataset: DatasetModel;
  /** Its participants in the column order nobody hidden gives. */
  everyone: readonly ResultModel[];
  state: BenchState;
  dispatch: Dispatch<BenchAction>;
}): ReactNode {
  const hiddenHere = everyone.filter((r) => state.hidden.has(r.id));
  const shownCount = everyone.length - hiddenHere.length;
  const chips = [...state.chips].sort();
  const active = chips.length + hiddenHere.length;

  return (
    <div className="vb-toolbar" role="toolbar" aria-label="what the table and the graph show">
      <Dropdown act="dataset-menu" label={<DatasetLabel dataset={dataset} />} title="the dataset every number on the page is about" width={340}>
        {(close) => (
          <DatasetMenu
            bench={bench}
            dataset={dataset}
            onPick={(d) => {
              dispatch({ type: 'dataset', id: d.id, tags: allChipTags(d) });
              close();
            }}
          />
        )}
      </Dropdown>
      <span className="tsep" />
      <Seg act="view" opts={VIEW} cur={state.view} pad="0 11px" onPick={(value) => dispatch({ type: 'view', value })} />
      {state.view === 'latency' && (
        <Seg act="metric" opts={LATENCY} cur={state.latencyMetric} pad="0 8px" onPick={(value) => dispatch({ type: 'metric', value })} />
      )}
      <span className="tnote">{state.view === 'throughput' ? '32 clients · QPS, higher is better' : '1 client · ms, lower is better'}</span>

      <div className="pills">
        {chips.map((tag) => (
          <button key={tag} type="button" className="pill" data-act="unchip" data-tag={tag} title="remove this filter" onClick={() => dispatch({ type: 'chip', tag })}>
            {pillText(tag)}
            <span className="x">×</span>
          </button>
        ))}
        {hiddenHere.map((r) => (
          <button
            key={r.id}
            type="button"
            className="pill"
            data-act="unhide"
            data-pid={r.id}
            title="hidden · click to show it again"
            onClick={() => dispatch({ type: 'part', pid: r.id, visibleCount: shownCount })}
          >
            <s>{r.name}</s>
            <span className="x">×</span>
          </button>
        ))}
      </div>
      <Dropdown act="filter-menu" label="Filter" badge={active} align="right" width={400} title="rows by tag, participants by name">
        {() => <FilterMenu dataset={dataset} chips={state.chips} everyone={everyone} hidden={state.hidden} shownCount={shownCount} dispatch={dispatch} />}
      </Dropdown>
      <Dropdown act="display-menu" label="Display" align="right" width={350} title="how the grid is cut into rows, and what a cell prints">
        {() => <DisplayMenu state={state} dispatch={dispatch} />}
      </Dropdown>
    </div>
  );
}
