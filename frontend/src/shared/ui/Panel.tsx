/* The dithered offset card — searchbench's `panel()`: a shadow layer masked
   with the 4×5px dither SVG and a bordered body on top of it. */

import type { CSSProperties, ReactNode } from 'react';

export interface PanelProps {
  /** `flex:1` card that fills the column, and a flex body inside it. */
  grow?: boolean;
  /** Body gets `.fill` without the card growing — a fixed-height panel. */
  fillBody?: boolean;
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
}

export function Panel({ grow = false, fillBody = false, style, className, children }: PanelProps): ReactNode {
  return (
    <div className={'panel' + (grow ? ' grow' : '') + (className ? ' ' + className : '')} style={style}>
      <div className="sh" />
      <div className={grow || fillBody ? 'bd fill' : 'bd'}>{children}</div>
    </div>
  );
}
