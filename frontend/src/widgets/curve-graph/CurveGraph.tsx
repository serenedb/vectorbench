/* The graph: x recall, y the current metric on a log axis, one line per
   participant through its frontier points (filled), dominated points hollow, a
   dashed vertical line at each row's recall and a diamond at every crossing.

   Plain SVG, in two pieces that share one scale: the y axis, which stays put,
   and the plot, which may be wider than its pane and scroll under it
   (GraphPane) — what a reader compares sits close to recall 1, and a plot the
   width of the pane squeezes exactly that part. */

import type { ReactNode } from 'react';
import type { Metric } from '../../entities/results';
import { fmtKnobs, fmtMetric, metricUnit } from '../../shared/lib/format';
import { linTicks, logAxis } from '../../shared/lib/scale';
import type { GraphData } from './graphData';

const DASHES = ['', '6 3', '2 3', '8 3 2 3', '1 3'];
/** Room above the plot for the row labels, below it for the recall ticks. */
const MT = 24;
const MB = 30;
/** So a point at either end of the axis is not cut in half. */
const PAD_L = 10;
const PAD_R = 18;
/** Width of the pinned y axis. */
export const Y_AXIS_W = 58;

export interface GraphScale {
  /** The plot's size; the y axis is drawn beside it, `Y_AXIS_W` wide. */
  width: number;
  height: number;
  X: (recall: number) => number;
  Y: (value: number) => number;
  xTicks: number[];
  /** Decimals a recall tick needs at this step. */
  xDigits: number;
  yTicks: number[];
  top: number;
  bottom: number;
}

/** The finest recall step whose ticks stay at least `gap` px apart. */
function recallStep(span: number, width: number, gap = 52): number {
  for (const step of [0.005, 0.01, 0.02, 0.05, 0.1]) if ((width * step) / span >= gap) return step;
  return 0.1;
}

export function graphScale(data: GraphData, width: number, height: number): GraphScale {
  const w = Math.max(10, width - PAD_L - PAD_R);
  const h = Math.max(10, height - MT - MB);
  const xLo = data.xMin;
  const xHi = 1.0;
  const y = logAxis(data.yMin, data.yMax);
  const step = recallStep(xHi - xLo, w);
  return {
    width,
    height,
    X: (r) => PAD_L + ((Math.min(Math.max(r, xLo), xHi) - xLo) / (xHi - xLo)) * w,
    Y: (v) => MT + h - ((Math.log10(v) - Math.log10(y.lo)) / (Math.log10(y.hi) - Math.log10(y.lo))) * h,
    xTicks: linTicks(xLo, xHi, step),
    xDigits: step < 0.01 ? 3 : 2,
    yTicks: y.ticks,
    top: MT,
    bottom: MT + h,
  };
}

/** A bar the way the table prints it: two decimals for a declared one (0.95),
    three for the measured reach a group can fall back to (0.983). */
function fmtBar(r: number): string {
  const s = r.toFixed(3);
  return s.endsWith('0') ? r.toFixed(2) : s;
}

/** `V02, V06 @ 0.95`, `eq-10 · k=10 @ 0.95`: one label per distinct reading. */
function mergeMarkers(markers: GraphData['markers']): { key: string; recall: number; label: string }[] {
  const byReading = new Map<string, { recall: number; exact: boolean; labels: string[] }>();
  for (const m of markers) {
    const key = `${m.recall}|${m.exact}`;
    const entry = byReading.get(key) ?? { recall: m.recall, exact: m.exact, labels: [] };
    if (!entry.labels.includes(m.label)) entry.labels.push(m.label);
    byReading.set(key, entry);
  }
  return [...byReading.entries()]
    .sort((a, b) => a[1].recall - b[1].recall)
    .map(([key, e]) => ({ key, recall: e.recall, label: `${e.labels.join(', ')} ${e.exact ? 'exact' : '@ ' + fmtBar(e.recall)}` }));
}

/** The y axis: the metric's ticks and unit, pinned left of the plot. */
export function CurveYAxis({ scale, metric }: { scale: GraphScale; metric: Metric }): ReactNode {
  const x = Y_AXIS_W - 7;
  return (
    <svg className="curve-yaxis" width={Y_AXIS_W} height={scale.height} aria-hidden="true">
      {scale.yTicks.map((t) => (
        <text key={t} x={x} y={scale.Y(t) + 3.5} textAnchor="end" style={{ fill: 'var(--mut)', fontSize: 10 }}>
          {fmtMetric(metric, t)}
        </text>
      ))}
      <text x={x} y={scale.top - 10} textAnchor="end" style={{ fill: 'var(--mut)', fontSize: 9.5, fontWeight: 700 }}>
        {metricUnit(metric)}
      </text>
      <line x1={Y_AXIS_W - 0.5} x2={Y_AXIS_W - 0.5} y1={scale.top} y2={scale.bottom} style={{ stroke: 'var(--line)', strokeWidth: 1 }} />
    </svg>
  );
}

export function CurveGraph({ data, metric, scale }: { data: GraphData; metric: Metric; scale: GraphScale }): ReactNode {
  const { X, Y, width, top, bottom } = scale;
  const empty = data.series.length === 0;

  return (
    <svg className="curve-graph" width={width} height={scale.height} role="img" aria-label="recall against the metric, one line per participant">
      {/* grid */}
      {scale.yTicks.map((t) => (
        <line key={'y' + t} x1={0} x2={width} y1={Y(t)} y2={Y(t)} style={{ stroke: 'var(--line2)', strokeWidth: 1 }} />
      ))}
      {scale.xTicks.map((t) => (
        <g key={'x' + t}>
          <line x1={X(t)} x2={X(t)} y1={top} y2={bottom} style={{ stroke: 'var(--line2)', strokeWidth: 1 }} />
          <text x={X(t)} y={bottom + 14} textAnchor="middle" style={{ fill: 'var(--mut)', fontSize: 10 }}>
            {t.toFixed(scale.xDigits)}
          </text>
        </g>
      ))}
      <line x1={0} x2={width} y1={bottom} y2={bottom} style={{ stroke: 'var(--line)', strokeWidth: 1 }} />
      <text x={width - 4} y={bottom + 26} textAnchor="end" style={{ fill: 'var(--mut)', fontSize: 9.5, fontWeight: 700 }}>
        recall
      </text>

      {/* row markers: rows read at the same recall share one line and one label */}
      {mergeMarkers(data.markers).map((m, i) => (
        <g key={m.key}>
          <line x1={X(m.recall)} x2={X(m.recall)} y1={top} y2={bottom} style={{ stroke: 'var(--fg)', strokeWidth: 1, strokeDasharray: '4 3', opacity: 0.55 }} />
          <text x={X(m.recall) - 4} y={top - 10 + (i % 2) * 11} textAnchor="end" style={{ fill: 'var(--fg)', fontSize: 9.5, fontWeight: 700, opacity: 0.8 }}>
            {m.label}
          </text>
        </g>
      ))}

      {/* series */}
      {data.series.map((s) => (
        <g key={s.id}>
          {s.line.length > 1 && (
            <polyline
              points={s.line.map((p) => `${X(p.recall)},${Y(p.value)}`).join(' ')}
              fill="none"
              style={{ stroke: s.color, strokeWidth: 1.7, strokeDasharray: DASHES[s.groupIndex % DASHES.length] || undefined, opacity: 0.95 }}
            />
          )}
          {s.points.map((p) => (
            <circle
              key={p.index}
              cx={X(p.recall)}
              cy={Y(p.value)}
              r={3.4}
              style={{ fill: p.onFrontier ? s.color : 'var(--card)', stroke: s.color, strokeWidth: 1.4 }}
            >
              <title>{`${s.name} · ${s.groupTitle} · ${fmtKnobs(p.knobs)} · recall ${p.recall.toFixed(4)} · ${fmtMetric(metric, p.value)} ${metricUnit(metric)}${p.onFrontier ? '' : ' · dominated'}`}</title>
            </circle>
          ))}
        </g>
      ))}

      {/* crossings */}
      {data.crossings.map((c) => {
        const cx = X(c.recall);
        const cy = Y(c.value);
        const s = data.series.find((x) => x.pid === c.pid && data.markers.some((m) => m.qid === c.qid && m.groupKey === x.groupKey));
        const first = s?.line[0];
        return (
          <g key={c.pid + '|' + c.qid}>
            {c.status === 'above' && first && (
              <line x1={cx} x2={X(first.recall)} y1={cy} y2={Y(first.value)} style={{ stroke: c.color, strokeWidth: 1, strokeDasharray: '1 3' }} />
            )}
            <rect
              x={cx - 4.5}
              y={cy - 4.5}
              width={9}
              height={9}
              transform={`rotate(45 ${cx} ${cy})`}
              style={{ fill: c.status === 'above' ? 'var(--card)' : c.color, stroke: 'var(--fg)', strokeWidth: 1.2 }}
            >
              <title>{`${c.name} · ${c.label} · ${fmtMetric(metric, c.value)} ${metricUnit(metric)} at recall ${fmtBar(c.recall)} · ${c.status}`}</title>
            </rect>
          </g>
        );
      })}

      {empty && (
        <text x={width / 2} y={(top + bottom) / 2} textAnchor="middle" style={{ fill: 'var(--mut)', fontSize: 12 }}>
          no measured points for these rows in this view
        </text>
      )}
    </svg>
  );
}

/** Colour swatches for the participants, and dash samples for the groups when there are several. */
export function GraphLegend({ data }: { data: GraphData }): ReactNode {
  const seen = new Map<string, { name: string; color: string }>();
  for (const s of data.series) if (!seen.has(s.pid)) seen.set(s.pid, { name: s.name, color: s.color });
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 10.5, color: 'var(--mut)', alignItems: 'center', paddingLeft: Y_AXIS_W - 6 }}>
      {[...seen.values()].map((p) => (
        <span key={p.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span className="swatch" style={{ background: p.color }} />
          {p.name}
        </span>
      ))}
      {data.groups.length > 1 &&
        data.groups.map((g, i) => (
          <span key={g.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <svg width="26" height="8">
              <line x1="0" x2="26" y1="4" y2="4" style={{ stroke: 'var(--fg)', strokeWidth: 1.7, strokeDasharray: DASHES[i % DASHES.length] || undefined }} />
            </svg>
            {g.title}
          </span>
        ))}
      <span>● frontier · ○ dominated · ◆ crossing (the cell)</span>
    </div>
  );
}
