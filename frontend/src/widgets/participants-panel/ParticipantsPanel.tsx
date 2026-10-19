/* The participant list — searchbench's participants panel, as the legend of
   this page rather than a filter. Rows are in column order, each with the
   colour the participant wears in every graph and detail, and the one panel
   that grows: it takes whatever height the three above it leave and scrolls.

   There are no show/hide toggles, and that is the page's logic and not an
   omission: a column hidden here would still be the best of some rows and the
   participant every group's common recall bar has to reach, so removing it
   from view would change the numbers left on screen. The head names the
   hardware tier the results were measured on, which is the one thing every
   column shares. */

import type { ReactNode } from 'react';
import { participantColor, type DatasetModel, type ResultModel } from '../../entities/results';
import { fmtBytes, fmtKnobs } from '../../shared/lib/format';
import { Panel } from '../../shared/ui';

/** The hardware tier every result of the dataset was run on, or a note that they differ. */
function tierOf(dataset: DatasetModel): string {
  const tiers = new Set(
    dataset.results.map((r) => {
      const h = r.raw.hardware;
      if (!h) return 'unknown tier';
      return [`${h.cpus} CPUs`, h.memory_bytes ? fmtBytes(h.memory_bytes) : null, h.storage || null].filter(Boolean).join(' · ');
    }),
  );
  return tiers.size === 1 ? [...tiers][0] : 'mixed tiers (see each tooltip)';
}

function tooltip(r: ResultModel): string {
  const raw = r.raw;
  return [
    `${r.name} · ${r.system} · ${raw.family} index`,
    raw.version ? `v${raw.version}` : null,
    raw.label ? `label ${raw.label}` : null,
    [raw.os, raw.date].filter(Boolean).join(' · ') || null,
    (raw.tags ?? []).join(' · ') || null,
    raw.index?.params ? `index: ${fmtKnobs(raw.index.params)}` : null,
    raw.hardware ? `tier: ${raw.hardware.host}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function ParticipantsPanel({
  dataset,
  results,
}: {
  dataset: DatasetModel;
  /** The dataset's participants, in column order. */
  results: readonly ResultModel[];
}): ReactNode {
  const tier = tierOf(dataset);
  return (
    <Panel grow style={{ flex: 1, minHeight: 96, display: 'flex' }}>
      <div className="ph">
        <span className="pr">&gt;</span>
        <span className="pt">participants</span>
        <span
          className="note"
          title={tier}
          style={{ marginLeft: 'auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {tier}
        </span>
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
        {results.map((r) => (
          <div key={r.id} className="prow" data-pid={r.id} title={tooltip(r)}>
            <span className="swatch" style={{ background: participantColor(r.id) }} />
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
            <span style={{ fontSize: 10, color: 'var(--mut)', whiteSpace: 'nowrap' }}>
              {r.raw.version ? 'v' + r.raw.version : ''}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
