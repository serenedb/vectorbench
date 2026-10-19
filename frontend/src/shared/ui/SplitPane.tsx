/* Two panes side by side and the rule between them, which drags (or moves
   with ← → once focused). Until the reader moves it the left pane takes
   `defaultLeft`; after that its share of the width is the reader's, kept in
   localStorage for the next visit — a convenience of one browser, so storage
   that throws or comes back empty only means the default again. A
   double-click on the rule goes back to the default. */

import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

function readShare(key: string): number | null {
  try {
    const v = Number(window.localStorage.getItem(key));
    return v > 0 && v < 1 ? v : null;
  } catch {
    return null;
  }
}

function writeShare(key: string, v: number | null): void {
  try {
    if (v === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, v.toFixed(4));
  } catch {
    /* a private window or blocked storage: the split still moves, unremembered */
  }
}

export interface SplitPaneProps {
  /** localStorage key for the share the reader picked. */
  storageKey: string;
  /** The left pane's width before the reader picks one: any CSS length. */
  defaultLeft: string;
  minLeft?: number;
  minRight?: number;
  left: ReactNode;
  right: ReactNode;
}

export function SplitPane({ storageKey, defaultLeft, minLeft = 380, minRight = 320, left, right }: SplitPaneProps): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const leftPane = useRef<HTMLDivElement>(null);
  const [share, setShare] = useState<number | null>(() => readShare(storageKey));
  const [dragging, setDragging] = useState(false);

  /** Puts the rule at `x` px from the left edge, within both panes' minimums. */
  const place = (x: number): number | null => {
    const width = box.current?.getBoundingClientRect().width ?? 0;
    if (width <= minLeft + minRight) return null;
    const next = Math.min(Math.max(x, minLeft), width - minRight) / width;
    setShare(next);
    return next;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !box.current) return;
    e.preventDefault();
    const rule = e.currentTarget;
    const origin = box.current.getBoundingClientRect().left;
    rule.setPointerCapture(e.pointerId);
    let last: number | null = null;
    const move = (ev: globalThis.PointerEvent) => {
      last = place(ev.clientX - origin) ?? last;
    };
    const up = () => {
      rule.removeEventListener('pointermove', move);
      rule.removeEventListener('pointerup', up);
      rule.removeEventListener('pointercancel', up);
      setDragging(false);
      if (last !== null) writeShare(storageKey, last);
    };
    rule.addEventListener('pointermove', move);
    rule.addEventListener('pointerup', up);
    rule.addEventListener('pointercancel', up);
    setDragging(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const now = leftPane.current?.getBoundingClientRect().width ?? 0;
    const next = place(now + (e.key === 'ArrowLeft' ? -32 : 32));
    if (next !== null) writeShare(storageKey, next);
  };

  return (
    <div className={'split' + (dragging ? ' dragging' : '')} ref={box}>
      <div
        className="pane"
        ref={leftPane}
        style={{ width: share === null ? defaultLeft : `${(share * 100).toFixed(2)}%`, minWidth: minLeft, maxWidth: `calc(100% - ${minRight}px)` }}
      >
        {left}
      </div>
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        title="drag to resize · double-click to reset"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => {
          setShare(null);
          writeShare(storageKey, null);
        }}
      />
      <div className="pane" style={{ flex: 1 }}>
        {right}
      </div>
    </div>
  );
}
