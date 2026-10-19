/* A toolbar button and the menu it drops under itself — the page's one way of
   keeping a control out of sight until it is asked for: the dataset list, the
   filters, the display options. The menu is a card in the page's panel style
   lined up with its button; a click outside, Escape or the button again closes
   it, and a pick that ends the choice closes it through `close`.

   Escape is caught on window in the capture phase and stopped there, so the
   page's own Escape (which closes a detail) never fires under an open menu. */

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface DropdownProps {
  /** `data-act` on the button, and `data-role` on the menu it opens. */
  act: string;
  /** What the button says. */
  label: ReactNode;
  title?: string;
  /** A count after the label — how many filters are on; nothing at 0. */
  badge?: number;
  /** The edge of the button the menu lines up with. */
  align?: 'left' | 'right';
  /** Menu width in px, its shadow included. */
  width?: number;
  /** Drawn only while open. */
  children: (close: () => void) => ReactNode;
}

export function Dropdown({ act, label, title, badge = 0, align = 'left', width, children }: DropdownProps): ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>(':scope > .tbtn')?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="dd" ref={root}>
      <button
        type="button"
        className="tbtn"
        data-act={act}
        aria-haspopup="true"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        {badge > 0 && <span className="badge">{badge}</span>}
        <svg className="caret" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
          <path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {open && (
        <div className="panel ddmenu" data-role={act} style={{ [align]: 0, width }}>
          <div className="sh" />
          <div className="bd">{children(() => setOpen(false))}</div>
        </div>
      )}
    </div>
  );
}
