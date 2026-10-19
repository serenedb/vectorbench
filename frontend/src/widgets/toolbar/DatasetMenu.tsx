/* The dataset: a toolbar button that names the one on screen, and the menu
   it opens — one row per dataset size that has results, the `<family>-<size>`
   id, its size and dimension in the mono face, and how many participants ran
   it. Which corpus the numbers are about is the first thing a reader needs and
   the one choice that changes every value on the page, so the button is the
   first thing in the toolbar and says it in full.

   Sizes a family declares but nobody has run are not listed: a row that cannot
   be picked is a promise, not a dataset. */

import type { ReactNode } from 'react';
import type { Benchmark, DatasetModel } from '../../entities/results';
import { fmtInt } from '../../shared/lib/format';

/** `1M` for the button, where the exact count would not fit beside the name. */
function fmtRows(n: number): string {
  if (n >= 1e9 && n % 1e9 === 0) return n / 1e9 + 'B';
  if (n >= 1e6 && n % 1e6 === 0) return n / 1e6 + 'M';
  if (n >= 1e3 && n % 1e3 === 0) return n / 1e3 + 'k';
  return fmtInt(n);
}

/** What the toolbar button says: the id, and the corpus in short. */
export function DatasetLabel({ dataset }: { dataset: DatasetModel }): ReactNode {
  const fam = dataset.family;
  return (
    <>
      <span className="dsname">{dataset.id}</span>
      <span className="dsmeta">
        {fmtRows(dataset.rows)} × {fam.dims}-d · {fam.metric}
      </span>
    </>
  );
}

export function DatasetMenu({ bench, dataset, onPick }: { bench: Benchmark; dataset: DatasetModel; onPick: (d: DatasetModel) => void }): ReactNode {
  return (
    <>
      <div className="ddhead">
        <span>dataset</span>
        {bench.generated && <span className="note">assembled {bench.generated.slice(0, 10)}</span>}
      </div>
      <div style={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {bench.datasets.map((d) => {
          const on = d.id === dataset.id;
          const fam = d.family;
          const n = d.results.length;
          return (
            <button
              key={d.id}
              type="button"
              className={'dsrow' + (on ? ' on' : '')}
              data-act="dataset"
              data-name={d.id}
              aria-pressed={on}
              title={[fam.title, `${fmtInt(d.rows)} vectors · ${fam.dims}-d · ${fam.metric}`, fam.description].filter(Boolean).join('\n')}
              onClick={() => onPick(d)}
            >
              {/* Kept in the layout at opacity 0, so the names do not shift as the selection moves. */}
              <span className="dsmark" style={{ opacity: on ? 1 : 0 }}>
                ✓
              </span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, overflow: 'hidden' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.id}</span>
                <span style={{ font: '700 10px var(--mono)', color: 'var(--mut)', letterSpacing: '.03em', whiteSpace: 'nowrap' }}>
                  {fmtInt(d.rows)} × {fam.dims}-d · {fam.metric}
                </span>
              </span>
              <span style={{ fontSize: 10, color: 'var(--mut)', whiteSpace: 'nowrap' }}>
                {n} participant{n === 1 ? '' : 's'}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
