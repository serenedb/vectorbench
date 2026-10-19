/* The strip under the grid, on one line: the colour ramp the cells are painted
   with, the grey of a failed cell, and the gestures the table answers to. What
   the cells measure is already in the results head and the sidebar, so it is
   not repeated here. */

import type { CSSProperties, ReactNode } from 'react';
import { ratioBg } from '../../shared/lib/color';

const item: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4 };

export function TableLegend(): ReactNode {
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
      <span>click a row for its curves · click a cell for the measurements · click a GENERAL row for its detail</span>
    </div>
  );
}
