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
