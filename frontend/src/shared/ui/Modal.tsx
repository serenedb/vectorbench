/* The overlay every detail opens in: a dimmed backdrop (click closes), a card
   with the page's panel head, and a scrolling body. Escape is handled by
   useBenchShortcuts on window. */

import type { CSSProperties, ReactNode } from 'react';

export interface ModalProps {
  /** Small uppercase word in the head: "query detail", "curves". */
  kicker: string;
  title: ReactNode;
  meta?: ReactNode;
  /** `data-role` on the card, for tests. */
  role?: string;
  width?: string;
  height?: string;
  onClose: () => void;
  children: ReactNode;
}

const BODY: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px' };

export function Modal({ kicker, title, meta, role, width = 'min(1120px, 94vw)', height, onClose, children }: ModalProps) {
  return (
    <div className="modal" data-act="modal-close" onClick={onClose}>
      <div
        className="panel"
        data-role={role}
        onClick={(e) => e.stopPropagation()}
        style={{ padding: '0 10px 10px 0', width, height, maxHeight: '92vh', display: 'flex' }}
      >
        <div className="sh" />
        <div className="bd fill" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="ph" style={{ padding: '8px 14px' }}>
            <span className="pr">&gt;</span>
            <span className="pt">{kicker}</span>
            <span className="mh">{title}</span>
            {meta && <span className="note" style={{ fontSize: 11, marginLeft: 6 }}>{meta}</span>}
            <button type="button" className="xbtn" data-act="modal-close" title="close (Esc)" onClick={onClose} style={{ marginLeft: 'auto' }}>
              ×
            </button>
          </div>
          <div style={BODY}>{children}</div>
        </div>
      </div>
    </div>
  );
}
