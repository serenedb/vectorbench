import { BenchPage } from '../pages/bench/BenchPage';
import './vectorbench.css';

/** Shared results page. The host supplies results (provideResults) and a
 * ThemeProvider; the standalone entry does both when opened outside the playground. */
export function ProductApp() {
  return (
    <div data-product="vectorbench">
      <BenchPage />
    </div>
  );
}
