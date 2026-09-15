// Initialise the shared data module before ProductApp evaluates dataset.ts.
// Only the standalone entry imports JSON; the playground injects its own data.
import data from '../results.json';
import { provideResults } from './entities/results/model/source';
import type { RawResults } from './entities/results/model/types';

provideResults(data as unknown as RawResults);
