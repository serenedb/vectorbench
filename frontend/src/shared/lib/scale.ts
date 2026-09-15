/* Chart axis ranges. `niceLog` is searchbench's; `logTicks` adds the 2 and 5
   sub-ticks a graph spanning one or two decades needs, and `linTicks` is the
   recall axis. */

export interface AxisScale {
  lo: number;
  hi: number;
  /** Ascending, `lo` and `hi` included. */
  ticks: number[];
}

/** Decade-aligned log axis covering [min, max], one tick per power of ten. */
export function niceLog(min: number, max: number): AxisScale {
  const lo = Math.pow(10, Math.floor(Math.log10(min)));
  const hi = Math.pow(10, Math.ceil(Math.log10(max)));
  const ticks: number[] = [];
  for (let p = Math.log10(lo); p <= Math.log10(hi) + 1e-9; p++) ticks.push(Math.pow(10, Math.round(p)));
  return { lo, hi, ticks };
}

/**
 * Log axis for a graph: the range is padded by a few percent so no marker sits
 * on the frame, and the ticks are 1-2-5 per decade when there are two decades
 * or fewer, plain decades otherwise.
 */
export function logAxis(min: number, max: number): AxisScale {
  if (!(min > 0)) min = 1e-3;
  if (!(max >= min)) max = min * 10;
  const pad = max / min < 1.5 ? 1.25 : 1.08;
  const lo = min / pad;
  const hi = max * pad;
  const decades = Math.log10(hi) - Math.log10(lo);
  const mant = decades <= 2.2 ? [1, 2, 5] : [1];
  const ticks: number[] = [];
  for (let p = Math.floor(Math.log10(lo)); p <= Math.ceil(Math.log10(hi)); p++) {
    for (const m of mant) {
      const t = m * Math.pow(10, p);
      if (t >= lo && t <= hi) ticks.push(t);
    }
  }
  return { lo, hi, ticks };
}

/** Ticks every `step` inside [lo, hi], on multiples of `step`. */
export function linTicks(lo: number, hi: number, step: number): number[] {
  const start = Math.ceil(lo / step - 1e-9) * step;
  const out: number[] = [];
  for (let t = start; t <= hi + 1e-9; t += step) out.push(Number(t.toFixed(6)));
  return out;
}
