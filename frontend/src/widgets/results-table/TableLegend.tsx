/* The strip under the grid: the colour ramp the cells are painted with, the
   grey of a failed cell, and one sentence naming the view, the unit and every
   gesture the table answers to. */

import type { CSSProperties, ReactNode } from 'react';
import { ratioBg } from '../../shared/lib/color';
import { metricUnit } from '../../shared/lib/format';
import { VIEW_LABELS, type BenchState } from '../../shared/model';

const item: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4 };

export function TableLegend({ state, metric }: { state: BenchState; metric: string }): ReactNode {
  const unit =
    state.cells === 'relative'
      ? "ratio to the row's best (x1.00)"
      : `absolute ${metricUnit(metric)}`;
  return (
    <div className="legend">
      <span style={item}>
        <span className="sw" style={{ background: ratioBg(1) }} />
        best
      </span>
      <span style={item}>
        <span className="sw" style={{ background: ratioBg(2) }} />
        x2
      </span>
      <span style={item}>
        <span className="sw" style={{ background: ratioBg(5) }} />
        x5
      </span>
      <span style={item}>
        <span className="sw" style={{ background: ratioBg(10) }} />
        x10+
      </span>
      <span style={item}>
        <span className="sw" style={{ background: 'var(--na)', border: '.5px solid var(--line)' }} />
        failed (the cell says why)
      </span>
      <span>
        {VIEW_LABELS[state.view]} · {metric} · {unit} · columns by{' '}
        {state.sortSection === 'nofilter' ? 'NO FILTER' : 'FILTERED'} coverage, then score · click a row for its
        curves · click a cell for the measurements · click a GENERAL row for its detail
      </span>
    </div>
  );
}
