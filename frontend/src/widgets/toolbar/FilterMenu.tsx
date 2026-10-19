/* Filter: which rows and which participants the comparison is over — the row
   chips and the participant switches, behind the toolbar's Filter button. The
   button counts what is on and the pills beside it name it, so a narrowed table
   says why while the menu is closed.

   Chips: one line per dimension — the filter case (by predicate, so `eq`
   covers eq-10 / eq-1 / eq-0.1), k, and the recall a row is read at. Within a
   line chips are OR-ed, across lines AND-ed (entities/results/model/rows.ts).
   One switched on narrows the rows everything is computed over, the score and
   coverage rows included. The chips offered are the dataset's own: a size can
   skip rows or read them at another bar, and a chip no row of this size
   answers to would only empty the table.

   Participants: switching one off takes it out of the comparison as well as
   out of view — every row's best, each group's common recall bar, the scores,
   the coverage and the column order are recomputed over the ones left
   (BenchPage), as searchbench measures every ratio against the fastest engine
   shown. The list keeps the order the columns take with nobody hidden, so a
   switch never reshuffles it under the pointer; one click never hides the last
   participant, and "select all" / "unselect all" acts on this dataset's
   participants only, so one hidden while another dataset was open keeps its
   state. */

import type { Dispatch, ReactNode } from 'react';
import { CHIP_DIMENSIONS, chipLabel, chipTag, participantColor, type ChipDimension, type DatasetModel, type ResultModel } from '../../entities/results';
import { fmtKnobs } from '../../shared/lib/format';
import type { BenchAction } from '../../shared/model';
import { ROW_LABEL } from '../../shared/ui';

const CHIP_TITLES: Record<ChipDimension, string> = {
  filter: 'show only rows with this filter case — scores and coverage recompute',
  k: 'show only rows with this k — scores and coverage recompute',
  recall: 'show only rows at this recall — scores and coverage recompute',
};

function tooltip(r: ResultModel): string {
  const raw = r.raw;
  const h = raw.hardware;
  return [
    `${r.name} · ${r.system} · ${raw.family} index`,
    raw.version ? `v${raw.version}` : null,
    raw.label ? `label ${raw.label}` : null,
    [raw.os, raw.date].filter(Boolean).join(' · ') || null,
    (raw.tags ?? []).join(' · ') || null,
    raw.index?.params ? `index: ${fmtKnobs(raw.index.params)}` : null,
    h ? `tier: ${[h.host, h.storage].filter(Boolean).join(' · ')}` : null,
    'click to show / hide',
  ]
    .filter(Boolean)
    .join('\n');
}

export function FilterMenu({
  dataset,
  chips,
  everyone,
  hidden,
  shownCount,
  dispatch,
}: {
  dataset: DatasetModel;
  chips: ReadonlySet<string>;
  /** Every participant of the dataset, hidden ones included, in the column order nobody hidden gives. */
  everyone: readonly ResultModel[];
  hidden: ReadonlySet<string>;
  /** Participants of the dataset on screen now. */
  shownCount: number;
  dispatch: Dispatch<BenchAction>;
}): ReactNode {
  const present = everyone.map((r) => r.id);
  const allShown = present.length > 0 && !present.some((p) => hidden.has(p));
  return (
    <>
      <div className="ddhead">
        <span>queries</span>
        <span className="note">rows by tag</span>
        {chips.size > 0 && (
          <button type="button" className="link" data-act="clear-chips" onClick={() => dispatch({ type: 'clear-chips' })}>
            clear
          </button>
        )}
      </div>
      <div style={{ padding: '9px 10px', display: 'flex', flexDirection: 'column', gap: 7 }}>
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
                      className={chips.has(tag) ? 'chip on' : 'chip'}
                      data-act="chip"
                      data-tag={tag}
                      aria-pressed={chips.has(tag)}
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

      <div className="ddhead">
        <span>participants</span>
        <span className="note">
          {shownCount} of {present.length} shown
        </span>
        {present.length > 0 && (
          <button type="button" className="link" data-act="toggle-all" onClick={() => dispatch({ type: 'toggle-all', present })}>
            {allShown ? 'unselect all' : 'select all'}
          </button>
        )}
      </div>
      <div style={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 280, overflowY: 'auto' }}>
        {everyone.map((r) => {
          const off = hidden.has(r.id);
          return (
            <button
              key={r.id}
              type="button"
              className="prow"
              data-act="part"
              data-pid={r.id}
              aria-pressed={!off}
              title={tooltip(r)}
              style={{ opacity: off ? 0.45 : 1 }}
              onClick={() => dispatch({ type: 'part', pid: r.id, visibleCount: shownCount })}
            >
              <span className={'ck' + (off ? '' : ' on')} style={off ? undefined : { background: participantColor(r.id), borderColor: participantColor(r.id) }} />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: '12.5px',
                  fontWeight: 600,
                  color: 'var(--fg)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.name}
              </span>
              <span style={{ fontSize: 10, color: 'var(--mut)', whiteSpace: 'nowrap' }}>{off ? 'hidden' : r.raw.version ? 'v' + r.raw.version : ''}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
