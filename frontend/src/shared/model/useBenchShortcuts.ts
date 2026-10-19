/* The page's keyboard surface beyond the table's own (↑ ↓ between rows, Space
   to tick, in ResultsTable): Escape closes the detail. Bound on window, as
   searchbench binds it, because the modals hold nothing focusable except their
   close buttons. A menu that is open catches Escape before this does. */

import { useEffect } from 'react';
import type { Dispatch } from 'react';
import type { BenchAction } from './reducer';
import type { BenchState } from './state';

export function useBenchShortcuts(state: BenchState, dispatch: Dispatch<BenchAction>): void {
  const open = state.detail !== null;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'escape' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, dispatch]);
}
