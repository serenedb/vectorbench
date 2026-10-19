/* searchbench's maximise toggle: hides the sidebar so the table gets the whole
   window, and switches its own label and colours while it is on. */

import type { Dispatch } from 'react';
import type { BenchAction, BenchState } from '../model';

export function MaxButton({ state, dispatch }: { state: BenchState; dispatch: Dispatch<BenchAction> }) {
  const on = state.max;
  return (
    <button
      type="button"
      data-act="max"
      title={on ? 'restore the sidebar' : 'maximize — hide the sidebar'}
      onClick={() => dispatch({ type: 'max' })}
      style={{
        border: '.5px solid var(--line)',
        background: on ? 'var(--accent)' : 'var(--inset)',
        color: on ? '#fff' : 'var(--mut)',
        padding: '2px 8px',
        fontSize: 10,
        fontWeight: 700,
        cursor: 'pointer',
        marginLeft: 10,
      }}
    >
      {on ? '⛶ restore' : '⛶ max'}
    </button>
  );
}
