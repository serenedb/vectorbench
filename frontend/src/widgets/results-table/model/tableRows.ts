/* The rows of the results grid, in the order they are drawn (DESIGN.md section 2):

     GENERAL    load time · on disk · max memory during load · startup (avg)
     NO FILTER  max memory during queries · score · coverage · the rows with filter none
     FILTERED   max memory during queries · score · coverage · every other row

   Header rows read one number off the result file and are coloured relative
   (lower is better for all of them); score and coverage come from scores.ts;
   query rows come from the grid. Only the visible rows (chips) are listed. */

import { groupFor, type DatasetModel, type QueryRow, type ResultModel, type Section } from '../../../entities/results';
import { fmtGB, fmtInt, fmtSec } from '../../../shared/lib/format';
import type { HeaderRowKey } from '../../../shared/model';

export interface SectionSpec {
  kind: 'section';
  key: string;
  title: string;
  note: string;
}

/** A GENERAL row or a section's memory row: one number per participant, lower is better. */
export interface HeaderSpec {
  kind: 'header';
  key: HeaderRowKey;
  label: string;
  unit: string;
  get: (r: ResultModel) => number | null;
  fmt: (v: number) => string;
  /** What a missing number reads as: "—", or "unsupported" when the participant supports none of the section. */
  missing: (r: ResultModel) => string;
  title: string;
}

export interface ScoreSpec {
  kind: 'score';
  key: string;
  section: Section;
}

export interface CoverageSpec {
  kind: 'coverage';
  key: string;
  section: Section;
}

export interface QuerySpec {
  kind: 'query';
  key: string;
  row: QueryRow;
}

export type RowSpec = SectionSpec | HeaderSpec | ScoreSpec | CoverageSpec | QuerySpec;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Every group of the participant in the section, in both views, is missing or `unsupported`. */
function supportsNothing(r: ResultModel, section: Section): boolean {
  const rows = r.queries.filter((q) => q.section === section);
  if (!rows.length) return false;
  for (const q of rows) {
    for (const view of ['throughput', 'latency'] as const) {
      const g = groupFor(r, q, view);
      if (g && g.status !== 'unsupported') return false;
    }
  }
  return true;
}

function memoryRow(section: Section): HeaderSpec {
  const field = section === 'nofilter' ? 'unfiltered' : 'filtered';
  return {
    kind: 'header',
    key: `memq:${section}`,
    label: 'max memory during queries',
    unit: '(GB)',
    get: (r) => num(r.raw.memory_peak?.[field]),
    fmt: fmtGB,
    missing: (r) => (supportsNothing(r, section) ? 'unsupported' : '—'),
    title: `cgroup memory.peak over the ${section === 'nofilter' ? 'no-filter' : 'filtered'} groups · shown, never scored · click for the numbers`,
  };
}

export function tableRows(dataset: DatasetModel, visible: readonly QueryRow[]): RowSpec[] {
  const fam = dataset.family;
  const out: RowSpec[] = [];
  out.push({
    kind: 'section',
    key: 'sec:general',
    title: 'GENERAL',
    note: `${dataset.id} · ${fmtInt(dataset.rows)} rows · ${fam.dims}-d · ${fam.metric} · ${dataset.results.length} participants · lower is better in every row`,
  });
  out.push(
    {
      kind: 'header',
      key: 'load',
      label: 'load time',
      unit: '(s)',
      get: (r) => num(r.raw.load_time),
      fmt: fmtSec,
      missing: () => '—',
      title: 'wall time of the participant’s load script, from empty engine to settled · click for the phases',
    },
    {
      kind: 'header',
      key: 'disk',
      label: 'on disk',
      unit: '(GB)',
      get: (r) => num(r.raw.disk_bytes),
      fmt: fmtGB,
      missing: () => '—',
      title: 'data + index right after load · click for the on-disk details',
    },
    {
      kind: 'header',
      key: 'memload',
      label: 'max memory during load',
      unit: '(GB)',
      get: (r) => num(r.raw.memory_peak?.load),
      fmt: fmtGB,
      missing: () => '—',
      title: 'cgroup memory.peak over the load phase · click for the numbers',
    },
    {
      kind: 'header',
      key: 'startup',
      label: 'startup (avg)',
      unit: '(s)',
      get: (r) => num(r.raw.startup?.avg),
      fmt: fmtSec,
      missing: () => '—',
      title: 'from start to the first successful check, one sample per group restart · click for the distribution',
    },
  );
  for (const section of ['nofilter', 'filtered'] as const) {
    const all = fam.queries.filter((q) => q.section === section);
    const rows = visible.filter((q) => q.section === section);
    out.push({
      kind: 'section',
      key: `sec:${section}`,
      title: section === 'nofilter' ? 'NO FILTER' : 'FILTERED',
      note: rows.length === all.length ? `${all.length} rows` : `${rows.length} of ${all.length} rows visible`,
    });
    out.push(memoryRow(section));
    out.push({ kind: 'score', key: `score:${section}`, section });
    out.push({ kind: 'coverage', key: `coverage:${section}`, section });
    for (const row of rows) out.push({ kind: 'query', key: 'q:' + row.id, row });
  }
  return out;
}
