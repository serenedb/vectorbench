/* Horizontal bars for the header details: one value per participant (smallest
   first), or one stacked bar of phases per participant. */

import type { ReactNode } from 'react';
import { participantColor } from '../../entities/results';

export interface BarItem {
  pid: string;
  name: string;
  value: number | null;
  /** What a missing value reads as. */
  missing?: string;
}

export function Bars({ items, fmt, sort = true }: { items: BarItem[]; fmt: (v: number) => string; sort?: boolean }): ReactNode {
  const list = sort ? [...items].sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity)) : items;
  const max = Math.max(0, ...list.map((i) => i.value ?? 0));
  return (
    <div>
      {list.map((it) => (
        <div key={it.pid} className="hb">
          <span className="barlab">{it.name}</span>
          <div className="bar">
            {it.value !== null && it.value > 0 && (
              <div style={{ width: Math.max(0.6, (it.value / max) * 100).toFixed(2) + '%', background: participantColor(it.pid) }} title={`${it.name} · ${fmt(it.value)}`} />
            )}
          </div>
          <span className="bartxt">{it.value === null ? (it.missing ?? '—') : fmt(it.value)}</span>
        </div>
      ))}
    </div>
  );
}

export const PHASE_COLORS = ['#895af8', '#3386ff', '#5ed29a', '#ffb454', '#e06c9f', '#7fd7e0', '#d0c05a', '#ff7b6b'] as const;
export const OTHER_COLOR = 'color-mix(in srgb, var(--fg) 25%, transparent)';

export interface StackItem {
  pid: string;
  name: string;
  total: number | null;
  /** Ordered segments; `other` is appended by the caller. */
  segments: { name: string; value: number }[];
}

export function StackedBars({ items, phaseColor, fmt }: { items: StackItem[]; phaseColor: (phase: string) => string; fmt: (v: number) => string }): ReactNode {
  const list = [...items].sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));
  const max = Math.max(0, ...list.map((i) => Math.max(i.total ?? 0, i.segments.reduce((s, x) => s + x.value, 0))));
  return (
    <div>
      {list.map((it) => (
        <div key={it.pid} className="hb">
          <span className="barlab">{it.name}</span>
          <div className="bar">
            {it.segments.map((s) => (
              <div key={s.name} style={{ width: ((s.value / max) * 100).toFixed(2) + '%', background: phaseColor(s.name) }} title={`${it.name} · ${s.name}: ${fmt(s.value)}`} />
            ))}
          </div>
          <span className="bartxt">{it.total === null ? '—' : fmt(it.total)}</span>
        </div>
      ))}
    </div>
  );
}
