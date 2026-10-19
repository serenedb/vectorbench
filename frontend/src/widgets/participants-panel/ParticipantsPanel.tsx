/* The participant list and its visibility toggles — searchbench's participants
   panel. The one panel that grows: it takes whatever height the three above it
   leave and scrolls.

   Switching a participant off takes it out of the comparison as well as out of
   view: the page recomputes every row's best, each group's common recall bar,
   the scores, the coverage and the column order over the participants left on
   screen (BenchPage), as searchbench measures every ratio against the fastest
   engine shown.

   Rows are in the order the columns take with nobody hidden, so a participant
   switched off stays where it was instead of the list reshuffling under the
   pointer. Two guards travel with the clicks, both from searchbench: one click
   never hides the last participant on screen, and "select all" / "unselect
   all" acts on this dataset's participants only, so one hidden while another
   dataset was open keeps its state. */

import type { Dispatch, ReactNode } from 'react';
import { participantColor, type ResultModel } from '../../entities/results';
import { fmtKnobs } from '../../shared/lib/format';
import type { BenchAction } from '../../shared/model';
import { Panel } from '../../shared/ui';

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

export function ParticipantsPanel({
  everyone,
  hidden,
  shownCount,
  dispatch,
}: {
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
    <Panel grow style={{ flex: 1, minHeight: 96, display: 'flex' }}>
      <div className="ph">
        <span className="pr">&gt;</span>
        <span className="pt">participants</span>
        {present.length > 0 && (
          <button
            type="button"
            className="link"
            style={{ marginLeft: 'auto' }}
            data-act="toggle-all"
            onClick={() => dispatch({ type: 'toggle-all', present })}
          >
            {allShown ? 'unselect all' : 'select all'}
          </button>
        )}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
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
              style={{ opacity: off ? 0.4 : 1 }}
              onClick={() => dispatch({ type: 'part', pid: r.id, visibleCount: shownCount })}
            >
              <span className="swatch" style={{ background: participantColor(r.id) }} />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: '12.5px',
                  fontWeight: 600,
                  color: 'var(--fg)',
                  textDecoration: off ? 'line-through' : 'none',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.name}
              </span>
              <span style={{ fontSize: 10, color: 'var(--mut)', whiteSpace: 'nowrap' }}>
                {off ? 'hidden' : r.raw.version ? 'v' + r.raw.version : ''}
              </span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
