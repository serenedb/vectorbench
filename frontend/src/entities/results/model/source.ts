/* Results are supplied before ProductApp is imported. The standalone entry
 * embeds frontend/results.json; the playground can fetch a public or protected
 * variant without bundling it into the shared product code. Copied from
 * searchbench/frontend/src/entities/results/model/source.ts. */
import type { RawResults } from './types.ts';

let data: RawResults | null = null;

/** Called by the shell's loader before this product's modules are imported. */
export function provideResults(next: RawResults): void {
  data = next;
}

/**
 * Throws rather than defaulting to empty: a silently blank benchmark looks like
 * a real one with nothing in it, and the cause — a loader that did not run —
 * would be invisible on screen.
 */
export function takeResults(): RawResults {
  if (data === null) {
    throw new Error(
      'vectorbench results were never provided: the shell must call provideResults() ' +
        'from @vectorbench/frontend/results before importing @vectorbench/frontend',
    );
  }
  return data;
}

/** One entry in the run selector. */
export interface BenchRunOption {
  /** Opaque here: the embedder minted it and only the embedder decodes it. */
  id: string;
  /** `YYYY-MM-DD` the benchmark was measured, or null when the results say nothing. */
  date: string | null;
  /** Distinct participants behind that run — the "N participants" half of the label. */
  participants: number;
}

/** The runs a host offers for this page, and which of them is on screen. */
export interface RunSelection {
  /** Newest measurement first; the header shows them in this order. */
  runs: BenchRunOption[];
  /** Which of `runs` these results are. */
  currentId: string;
  /** The reader picked a run. Reporting it is all the product does with it. */
  onSelect: (id: string) => void;
}

let selection: RunSelection | null = null;

/**
 * Handed in ahead of this product's modules, through the same door as the
 * results and for the same reason: `dataset.ts` builds the benchmark from
 * `takeResults()` at module scope, so a document renders exactly one benchmark,
 * and which one it is has to be settled before the first import. A context or
 * a prop would arrive after those modules evaluated, which is one import too
 * late. searchbench's seam, with the same shape.
 *
 * `onSelect` is a report, not an action, because this package cannot carry out
 * the switch and should not pretend to: with the results frozen at module
 * scope, changing run is a document load, the host owns the routes it would
 * load, and the standalone build has no router to load anything with.
 */
export function provideRuns(next: RunSelection): void {
  selection = next;
}

/**
 * Null when nobody offered runs: the standalone entry embeds one results.json
 * and never calls `provideRuns`, so having no runs is the ordinary case and the
 * selector simply does not render.
 */
export function takeRuns(): RunSelection | null {
  return selection;
}
