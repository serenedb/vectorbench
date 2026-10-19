/* Display: how the grid is cut into rows and what a cell prints — two
   switches a reader sets once and leaves, so they wait behind the toolbar's
   Display button instead of taking a strip of the screen each. The load
   condition and its statistic, which a reader flips while comparing, stay in
   the toolbar itself (Toolbar). */

import type { Dispatch, ReactNode } from 'react';
import type { BenchAction, BenchState, CellMode, RowMode } from '../../shared/model';
import { SegRow, type SegOption } from '../../shared/ui';

const ROWS: readonly SegOption<RowMode>[] = [
  {
    label: 'By group',
    v: 'groups',
    title: 'one row per group, every participant read at the strongest recall bar all of them reach, with what each reaches on its own beside it',
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

export function DisplayMenu({ state, dispatch }: { state: BenchState; dispatch: Dispatch<BenchAction> }): ReactNode {
  return (
    <>
      <div className="ddhead">
        <span>display</span>
      </div>
      <div style={{ padding: '10px 10px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <SegRow label="rows" act="row-mode" opts={ROWS} cur={state.rowMode} onPick={(value) => dispatch({ type: 'row-mode', value })} />
        <SegRow label="cells" act="cells" opts={CELLS} cur={state.cells} onPick={(value) => dispatch({ type: 'cells', value })} />
      </div>
    </>
  );
}
