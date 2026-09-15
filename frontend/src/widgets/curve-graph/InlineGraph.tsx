/* The half-height graph that opens under a query row. It sits inside the
   table's scroll area, sticky to its left edge, so it stays put when the
   columns scroll sideways. */

import { useMemo, type Dispatch, type ReactNode } from 'react';
import type { Grid, QueryRow, ResultModel } from '../../entities/results';
import { fmtRecall, metricUnit } from '../../shared/lib/format';
import { VIEW_LABELS, type BenchAction } from '../../shared/model';
import { CurveGraph, GraphLegend } from './CurveGraph';
import { buildGraphData } from './graphData';
import { useSize } from './useSize';

export function InlineGraph({ results, row, grid, dispatch }: { results: readonly ResultModel[]; row: QueryRow; grid: Grid; dispatch: Dispatch<BenchAction> }): ReactNode {
  const [ref, size] = useSize<HTMLDivElement>();
  const data = useMemo(() => buildGraphData(results, [row], grid), [results, row, grid]);
  return (
    <div className="graphwrap" ref={ref} data-role="inline-graph">
      <div className="gh">
        <b>{row.id}</b>
        <span>
          {row.key} · {row.exact ? 'exact (brute force, recall 1.0)' : `recall ${fmtRecall(row.recall)}`} · {VIEW_LABELS[grid.view]} · y = {grid.metric} ({metricUnit(grid.metric)}), log
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="btn acc" data-act="graph-open" title="full screen, with other rows as extra lines" onClick={() => dispatch({ type: 'graph-open', id: row.id })}>
          ⛶ full screen
        </button>
        <button type="button" className="xbtn" title="close" onClick={() => dispatch({ type: 'row', id: row.id })}>
          ×
        </button>
      </div>
      {size.width > 0 && <CurveGraph data={data} metric={grid.metric} width={Math.max(300, size.width - 26)} height={232} />}
      <GraphLegend data={data} />
    </div>
  );
}
