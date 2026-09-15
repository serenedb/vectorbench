/* The sticky header row: the corner and one column per participant, in the
   current sort order. The tooltip carries what the mock's caption cannot:
   system, version, OS, run date, tags and the index parameters. */

import type { ReactNode } from 'react';
import { participantColor, type ResultModel } from '../../entities/results';
import { fmtKnobs } from '../../shared/lib/format';

export function TableHead({ results, gridCols }: { results: readonly ResultModel[]; gridCols: string }): ReactNode {
  return (
    <div className="thead" style={{ gridTemplateColumns: gridCols }}>
      <div className="corner">query \ participant</div>
      {results.map((r) => {
        const raw = r.raw;
        const tip = [
          `${r.system} · ${raw.family} index`,
          raw.version ? `v${raw.version}` : null,
          raw.label ? `label ${raw.label}` : null,
          raw.os,
          raw.date,
          (raw.tags ?? []).join(' · ') || null,
          raw.index?.params ? `index: ${fmtKnobs(raw.index.params)}` : null,
          raw.hardware ? `tier: ${raw.hardware.cpus} CPUs · ${raw.hardware.cpuset} · ${raw.hardware.host}` : null,
          raw._source ? `source: ${raw._source}` : null,
        ]
          .filter(Boolean)
          .join('\n');
        return (
          <div key={r.id} className="pcol" data-pid={r.id} title={tip}>
            <span className="swatch" style={{ background: participantColor(r.id) }} />
            {r.name}
          </div>
        );
      })}
    </div>
  );
}
