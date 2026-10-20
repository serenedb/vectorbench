/* The strip along the bottom of the window, on one line: what is on screen,
   the gestures the two panes answer to, and the colour ramp the cells are
   painted with. It replaces the table's own legend and its results head, which
   said the same things twice. */

import type { CSSProperties, ReactNode } from 'react';
import { latencyClients, type DatasetModel } from '../../entities/results';
import { ratioBg } from '../../shared/lib/color';
import { fmtInt } from '../../shared/lib/format';
import { VIEW_LABELS, type BenchState } from '../../shared/model';

const item: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4 };

export function StatusBar({
  dataset,
  shown,
  participants,
  rows,
  total,
  state,
}: {
  dataset: DatasetModel;
  /** Participants on screen, and in the dataset. */
  shown: number;
  participants: number;
  /** Rows the table lists in the reading on screen, and all it has. */
  rows: number;
  total: number;
  state: BenchState;
}): ReactNode {
  const unit = state.rowMode === 'groups' ? 'groups' : 'rows';
  const parts = [
    `${dataset.id} · ${fmtInt(dataset.rows)} vectors`,
    shown === participants ? `${participants} participants` : `${shown} of ${participants} participants`,
    rows === total ? `${total} ${unit}` : `${rows} of ${total} ${unit}`,
    state.view === 'latency' ? `Latency · ${latencyClients(dataset) ?? '—'} · ${state.latencyMetric}` : VIEW_LABELS.throughput,
  ];
  return (
    <div className="vb-status" data-role="status">
      <span className="st-meta">{parts.join(' · ')}</span>
      <span className="st-hint">tick rows to draw them · double-click: one alone · click a cell for its measurements · a GENERAL row for its detail</span>
      <span className="st-legend">
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
          failed
        </span>
      </span>
    </div>
  );
}
