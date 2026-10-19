/* The row chips — searchbench's categories panel with VectorBench's three
   dimensions, one line each: the filter case (by predicate, so `eq` covers
   eq-10 / eq-1 / eq-0.1), k, and the recall a row is read at. Within a line
   chips are OR-ed, across lines AND-ed (entities/results/model/rows.ts).

   Switching one on narrows the rows everything is computed over, the score and
   coverage rows included — they are means over the *visible* rows and so
   different numbers under a chip, which is what every chip's title says.

   The chips offered are the dataset's own: a size can skip rows or read them
   at another bar, and a chip no row of this size answers to would only empty
   the table. "clear" appears once something is on, so the head carries no dead
   control in the default view. */

import type { Dispatch } from 'react';
import { CHIP_DIMENSIONS, chipLabel, chipTag, type ChipDimension, type DatasetModel } from '../../entities/results';
import type { BenchAction, BenchState } from '../../shared/model';
import { Panel, ROW_LABEL } from '../../shared/ui';

const CHIP_TITLES: Record<ChipDimension, string> = {
  filter: 'show only rows with this filter case — scores and coverage recompute',
  k: 'show only rows with this k — scores and coverage recompute',
  recall: 'show only rows at this recall — scores and coverage recompute',
};

export function QueriesPanel({
  dataset,
  state,
  dispatch,
}: {
  dataset: DatasetModel;
  state: BenchState;
  dispatch: Dispatch<BenchAction>;
}) {
  return (
    <Panel>
      <div className="ph">
        <span className="pr">&gt;</span>
        <span className="pt">queries</span>
        <span className="note">filter rows by tag</span>
        {state.chips.size > 0 && (
          <button
            type="button"
            className="link"
            style={{ marginLeft: 'auto' }}
            data-act="clear-chips"
            onClick={() => dispatch({ type: 'clear-chips' })}
          >
            clear
          </button>
        )}
      </div>
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
        {CHIP_DIMENSIONS.map((dim) => (
          <div key={dim} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            {/* `k` stays lower-case: it is the variable, not a word. */}
            <span style={dim === 'k' ? { ...ROW_LABEL, textTransform: 'none' } : ROW_LABEL}>{dim}</span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {dataset.chips[dim].length ? (
                dataset.chips[dim].map((v) => {
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
                })
              ) : (
                <span style={{ fontSize: 10, color: 'var(--mut)' }}>none at this size</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
