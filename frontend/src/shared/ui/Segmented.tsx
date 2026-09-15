/* `seg()` — searchbench's bordered inset strip of buttons, exactly one `.on`.
   `data-act` / `data-v` stay on the buttons: the offline test drives the page
   through selectors like `[data-act="view"][data-v="latency"]`. */

import type { CSSProperties } from 'react';

export interface SegOption<V extends string> {
  label: string;
  v: V;
  disabled?: boolean;
  title?: string;
}

export interface SegProps<V extends string> {
  act: string;
  opts: readonly SegOption<V>[];
  cur: V;
  /** The strip takes the row's remaining width and divides it evenly. */
  grow?: boolean;
  pad?: string;
  fs?: string;
  onPick: (v: V) => void;
}

export function Seg<V extends string>({ act, opts, cur, grow = false, pad = '4px 9px', fs = '11px', onPick }: SegProps<V>) {
  return (
    <div className="seg" style={grow ? { flex: 1 } : undefined}>
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          className={o.v === cur ? 'on' : ''}
          data-act={act}
          data-v={o.v}
          disabled={o.disabled}
          aria-disabled={o.disabled ? 'true' : undefined}
          title={o.title || undefined}
          style={{ ...(grow ? { flex: 1 } : {}), padding: pad, fontSize: fs }}
          onClick={() => onPick(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const LABEL: CSSProperties = {
  flexShrink: 0,
  fontSize: '9.5px',
  fontWeight: 700,
  letterSpacing: '.07em',
  textTransform: 'uppercase',
  color: 'var(--mut)',
};

/** A caption in front of one or more controls — one group of the toolbar. */
export function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={LABEL}>{label}</span>
      {children}
    </div>
  );
}
