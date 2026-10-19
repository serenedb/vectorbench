/* The dataset picker — searchbench's dataset panel, one row per dataset size
   that has results: the `<family>-<size>` id, its size and dimension in the
   mono face, and how many participants ran it. Which corpus the numbers are
   about is the first thing a reader needs and the one control that changes
   every value on the page, hence the high-contrast active row.

   Sizes a family declares but nobody has run are not listed: a row that cannot
   be picked is a promise, not a dataset. */

import type { Dispatch } from 'react';
import { allChipTags, type Benchmark, type DatasetModel } from '../../entities/results';
import { fmtInt } from '../../shared/lib/format';
import type { BenchAction } from '../../shared/model';
import { Panel } from '../../shared/ui';

export function DatasetPanel({
  bench,
  dataset,
  dispatch,
}: {
  bench: Benchmark;
  /** The dataset on screen. */
  dataset: DatasetModel;
  dispatch: Dispatch<BenchAction>;
}) {
  return (
    <Panel className="dataset-panel">
      <div className="ph">
        <span className="pr">&gt;</span>
        <span className="pt">dataset</span>
        <span className="note" style={{ marginLeft: 'auto' }}>
          {bench.generated ? `assembled ${bench.generated.slice(0, 10)}` : 'vectors'}
        </span>
      </div>
      <div style={{ padding: 7, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {bench.datasets.map((d) => {
          const on = d.id === dataset.id;
          const fam = d.family;
          const n = d.results.length;
          return (
            <button
              key={d.id}
              type="button"
              className="dsrow"
              data-act="dataset"
              data-name={d.id}
              aria-pressed={on}
              title={[fam.title, `${fmtInt(d.rows)} vectors · ${fam.dims}-d · ${fam.metric}`, fam.description].filter(Boolean).join('\n')}
              style={{
                borderColor: on ? 'var(--accent)' : 'transparent',
                background: on ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
              }}
              onClick={() => dispatch({ type: 'dataset', id: d.id, tags: allChipTags(d) })}
            >
              {/* Kept in the layout at opacity 0, so the names below it do not
                  shift as the selection moves. */}
              <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 10, width: 7, opacity: on ? 1 : 0 }}>&gt;</span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 1,
                  overflow: 'hidden',
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--fg)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {d.id}
                </span>
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
    </Panel>
  );
}
