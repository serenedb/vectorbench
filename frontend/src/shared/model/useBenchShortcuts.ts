/* The page's keyboard surface: Escape closes the detail, then the full-screen
   graph. Bound on window, as searchbench binds it, because the modals hold
   nothing focusable except their close buttons. */

import { useEffect } from 'react';
import type { Dispatch } from 'react';
import type { BenchAction } from './reducer';
import type { BenchState } from './state';

export function useBenchShortcuts(state: BenchState, dispatch: Dispatch<BenchAction>): void {
  const anyOpen = state.detail !== null || state.graphRows !== null;
  useEffect(() => {
    if (!anyOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'escape' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [anyOpen, dispatch]);
}
