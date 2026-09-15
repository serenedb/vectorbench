/* The benchmark, indexed once at module load, from the results the shell
   provided (see source.ts). A results file that breaks the contract does not
   crash the module: the page renders `BENCH_ERROR` instead of a table. */

import { buildBenchmark, type Benchmark, type DatasetModel } from './model.ts';
import { takeResults } from './source.ts';

let bench: Benchmark | null = null;
let error: Error | null = null;
try {
  bench = buildBenchmark(takeResults());
} catch (e) {
  error = e instanceof Error ? e : new Error(String(e));
}

export const BENCH: Benchmark | null = bench;
export const BENCH_ERROR: Error | null = error;

export function datasetById(id: string | null | undefined): DatasetModel | undefined {
  if (!BENCH || !id) return undefined;
  return BENCH.datasets.find((d) => d.id === id);
}

/** This participant's colour, everywhere it appears. */
export function participantColor(pid: string): string {
  return BENCH?.colors.get(pid) ?? '#888888';
}
