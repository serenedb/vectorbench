/* The graph: x recall, y the current metric on a log axis, one line per
   participant through its frontier points (filled), dominated points hollow, a
   dashed vertical line at each row's recall and a diamond at every crossing.
   Plain SVG; sizes come from the container. */

import type { ReactNode } from 'react';
import type { Metric } from '../../entities/results';
import { fmtKnobs, fmtMetric, fmtRecall, metricUnit } from '../../shared/lib/format';
import { linTicks, logAxis } from '../../shared/lib/scale';
import type { GraphData } from './graphData';

const DASHES = ['', '6 3', '2 3', '8 3 2 3', '1 3'];

/** `V02, V06 @ 0.95`: one label per distinct recall. */
function mergeMarkers(markers: GraphData['markers']): { recall: number; label: string }[] {
  const byRecall = new Map<number, string[]>();
  for (const m of markers) {
    const list = byRecall.get(m.recall) ?? [];
    list.push(m.qid);
    byRecall.set(m.recall, list);
  }
  return [...byRecall.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([recall, ids]) => ({ recall, label: `${ids.join(', ')} @ ${recall === 1 ? 'exact' : fmtRecall(recall)}` }));
}

export function CurveGraph({ data, metric, width, height }: { data: GraphData; metric: Metric; width: number; height: number }): ReactNode {
  const ml = 66;
  const mr = 18;
  const mt = 20;
  const mb = 30;
  const w = Math.max(10, width - ml - mr);
  const h = Math.max(10, height - mt - mb);
  const xLo = data.xMin;
  const xHi = 1.0;
  const y = logAxis(data.yMin, data.yMax);
  const X = (r: number) => ml + ((Math.min(Math.max(r, xLo), xHi) - xLo) / (xHi - xLo)) * w;
  const Y = (v: number) => mt + h - ((Math.log10(v) - Math.log10(y.lo)) / (Math.log10(y.hi) - Math.log10(y.lo))) * h;
  const step = xHi - xLo <= 0.12 ? 0.01 : xHi - xLo <= 0.3 ? 0.02 : 0.05;
  const xTicks = linTicks(xLo, xHi, step);
  const empty = data.series.length === 0;

  return (
    <svg className="curve-graph" width={width} height={height} role="img" aria-label="recall against the metric, one line per participant">
      {/* frame and grid */}
      {y.ticks.map((t) => (
        <g key={'y' + t}>
          <line x1={ml} x2={ml + w} y1={Y(t)} y2={Y(t)} style={{ stroke: 'var(--line2)', strokeWidth: 1 }} />
          <text x={ml - 7} y={Y(t) + 3.5} textAnchor="end" style={{ fill: 'var(--mut)', fontSize: 10 }}>
            {fmtMetric(metric, t)}
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <g key={'x' + t}>
          <line x1={X(t)} x2={X(t)} y1={mt} y2={mt + h} style={{ stroke: 'var(--line2)', strokeWidth: 1 }} />
          <text x={X(t)} y={mt + h + 14} textAnchor="middle" style={{ fill: 'var(--mut)', fontSize: 10 }}>
            {fmtRecall(t)}
          </text>
        </g>
      ))}
      <line x1={ml} x2={ml} y1={mt} y2={mt + h} style={{ stroke: 'var(--line)', strokeWidth: 1 }} />
      <line x1={ml} x2={ml + w} y1={mt + h} y2={mt + h} style={{ stroke: 'var(--line)', strokeWidth: 1 }} />
      <text x={ml - 7} y={mt - 8} textAnchor="end" style={{ fill: 'var(--mut)', fontSize: 9.5, fontWeight: 700 }}>
        {metricUnit(metric)}
      </text>
      <text x={ml + w} y={mt + h + 26} textAnchor="end" style={{ fill: 'var(--mut)', fontSize: 9.5, fontWeight: 700 }}>
        recall
      </text>

      {/* row markers: rows at the same recall share one line and one label */}
      {mergeMarkers(data.markers).map((m, i) => (
        <g key={m.recall}>
          <line x1={X(m.recall)} x2={X(m.recall)} y1={mt} y2={mt + h} style={{ stroke: 'var(--fg)', strokeWidth: 1, strokeDasharray: '4 3', opacity: 0.55 }} />
          <text x={X(m.recall) - 4} y={mt - 8 + (i % 2) * 11} textAnchor="end" style={{ fill: 'var(--fg)', fontSize: 9.5, fontWeight: 700, opacity: 0.8 }}>
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
              <title>{`${s.name} · ${s.groupKey} · ${fmtKnobs(p.knobs)} · recall ${p.recall.toFixed(4)} · ${fmtMetric(metric, p.value)} ${metricUnit(metric)}${p.onFrontier ? '' : ' · dominated'}`}</title>
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
              <title>{`${c.name} · ${c.qid} · ${fmtMetric(metric, c.value)} ${metricUnit(metric)} at recall ${fmtRecall(c.recall)} · ${c.status}`}</title>
            </rect>
          </g>
        );
      })}

      {empty && (
        <text x={ml + w / 2} y={mt + h / 2} textAnchor="middle" style={{ fill: 'var(--mut)', fontSize: 12 }}>
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
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 10.5, color: 'var(--mut)', alignItems: 'center' }}>
      {[...seen.values()].map((p) => (
        <span key={p.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span className="swatch" style={{ background: p.color }} />
          {p.name}
        </span>
      ))}
      {data.groups.length > 1 &&
        data.groups.map((g, i) => (
          <span key={g} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <svg width="26" height="8">
              <line x1="0" x2="26" y1="4" y2="4" style={{ stroke: 'var(--fg)', strokeWidth: 1.7, strokeDasharray: DASHES[i % DASHES.length] || undefined }} />
            </svg>
            {g}
          </span>
        ))}
      <span>● frontier · ○ dominated · ◆ crossing (the cell)</span>
    </div>
  );
}
