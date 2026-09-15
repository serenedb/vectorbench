/* Every string the page prints. fmtSec / fmtBytes are searchbench's; the rest
   is VectorBench's own vocabulary (DESIGN.md section 2): QPS as an integer,
   latencies in ms with two decimals, ratios as "x1.00", recalls as "0.95". */

/** Seconds, 3 significant-ish digits: 123 / 12.3 / 1.23 / 0.123. */
export function fmtSec(s: number | null | undefined): string {
  if (typeof s !== 'number' || !Number.isFinite(s)) return '—';
  if (s >= 100) return s.toFixed(0);
  if (s >= 10) return s.toFixed(1);
  if (s >= 1) return s.toFixed(2);
  return s.toFixed(3);
}

/** Binary units, 1024-based, one decimal below 100 — for the detail lists. */
export function fmtBytes(b: number | null | undefined): string {
  if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}

/** Decimal gigabytes for the header rows, whose label carries the unit: 22 / 9.1 / 0.31. */
export function fmtGB(b: number | null | undefined): string {
  if (typeof b !== 'number' || !Number.isFinite(b) || b < 0) return '—';
  const g = b / 1e9;
  if (g >= 10) return g.toFixed(0);
  if (g >= 1) return g.toFixed(1);
  return g.toFixed(2);
}

/** Queries per second, as the mock prints it: an integer. */
export function fmtQps(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return v >= 10 ? Math.round(v).toString() : v.toFixed(1);
}

/** Milliseconds with two decimals. */
export function fmtMs(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return v.toFixed(2);
}

/** The current metric's unit, as a suffix: "QPS" or "ms". */
export function metricUnit(metric: string): string {
  return metric === 'qps' ? 'QPS' : 'ms';
}

/** `fmtQps` for qps, `fmtMs` for every latency statistic. */
export function fmtMetric(metric: string, v: number | null | undefined): string {
  return metric === 'qps' ? fmtQps(v) : fmtMs(v);
}

/** "x1.00", "x4.1", "x12", "x∞". The best cell in a row is always x1.00. */
export function fmtRatio(r: number | null | undefined): string {
  if (typeof r !== 'number') return '—';
  if (!Number.isFinite(r)) return 'x∞';
  return 'x' + (r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(2));
}

/** "0.90", "0.95", "0.999", "exact". */
export function fmtRecall(r: number | 'exact' | null | undefined): string {
  if (r === 'exact') return 'exact';
  if (typeof r !== 'number' || !Number.isFinite(r)) return '—';
  const two = r.toFixed(2);
  return Math.abs(Number(two) - r) < 1e-9 ? two : String(r);
}

/** "nprobe=8", "ef=64 · rerank=2"; "—" for the knob-less exact point. */
export function fmtKnobs(knobs: Record<string, unknown> | null | undefined): string {
  const entries = Object.entries(knobs ?? {});
  if (!entries.length) return '—';
  return entries.map(([k, v]) => `${k}=${String(v)}`).join(' · ');
}

/** "1,234,567". */
export function fmtInt(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? new Intl.NumberFormat('en-US').format(n) : '—';
}

/** A recall-like fraction with three decimals; "—" when missing. */
export function fmtFrac(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(3) : '—';
}
