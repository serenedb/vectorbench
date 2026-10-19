/* The right pane: the curves behind the rows ticked in the table on its left.
   There is nothing to pick here — the table is the list of what can be drawn
   and its ticks are what is drawn — so the pane is the graph, its legend, and
   a head that says what the axes are, how many rows are on and how to take
   them off.

   The plot is 80% of the screen wide, wider than the pane beside a table, and
   scrolls under a pinned y axis: what a reader compares sits close to recall
   1, which a plot squeezed to the pane would crowd into its last inch. It
   opens scrolled to that end and stays anchored there as the pane or the rows
   change, until the reader scrolls — by the scrollbar, the wheel, or dragging
   the plot.

   A row is drawn the way the table reads it (graphData.ts): in the group
   reading a group stands at the common bar its cells are read at, in the bar
   reading a query row at its own bar. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { DatasetModel, Grid, GroupRowModel, ResultModel } from '../../entities/results';
import { metricUnit } from '../../shared/lib/format';
import type { RowMode } from '../../shared/model';
import { CurveGraph, CurveYAxis, GraphLegend, Y_AXIS_W, graphScale } from './CurveGraph';
import { buildGraphData, groupPlotRow, queryPlotRow, type PlotRow } from './graphData';
import { useSize } from './useSize';

/** The plot and its axis together take this share of the screen's width. */
const SCREEN_SHARE = 0.8;

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

export function GraphPane({
  dataset,
  results,
  grid,
  mode,
  groups,
  plotted,
  ticked,
  onClear,
}: {
  /** The dataset with only the participants on screen. */
  dataset: DatasetModel;
  /** Participants in column order. */
  results: readonly ResultModel[];
  grid: Grid;
  mode: RowMode;
  /** The group rows on screen, for the group reading. */
  groups: readonly GroupRowModel[];
  /** Ids ticked and on screen, in the reading on screen. */
  plotted: readonly string[];
  /** Rows ticked in all, the ones the chips hide included. */
  ticked: number;
  onClear: () => void;
}): ReactNode {
  const rows = useMemo<PlotRow[]>(
    () =>
      plotted.flatMap((id) => {
        if (mode === 'groups') {
          const group = groups.find((g) => g.key === id);
          const query = dataset.queries.find((q) => q.key === id);
          return group && query ? [groupPlotRow(group, query)] : [];
        }
        const query = dataset.queries.find((q) => q.id === id);
        return query ? [queryPlotRow(query, results, grid)] : [];
      }),
    [plotted, mode, groups, dataset, results, grid],
  );
  const data = useMemo(() => buildGraphData(results, rows, grid), [results, rows, grid]);

  // Always mounted, so the size is known by the time a first row is ticked.
  const [viewRef, view] = useSize<HTMLDivElement>();
  const screen = useViewportWidth();
  const scroller = useRef<HTMLDivElement>(null);
  /* The horizontal scrollbar takes its height from the plot's, or the recall
     ticks would sit under it; measured, since a platform with overlay
     scrollbars takes none. */
  const [bar, setBar] = useState(0);
  const plotWidth = Math.max(view.width - Y_AXIS_W, Math.round(screen * SCREEN_SHARE) - Y_AXIS_W);
  const plotHeight = Math.max(0, view.height - bar);
  const scale = useMemo(() => graphScale(data, plotWidth, plotHeight), [data, plotWidth, plotHeight]);
  const drawn = rows.length > 0 && view.width > 0 && plotHeight > 0;

  // Distance from the right end the reader has scrolled to: 0 = recall 1 in view.
  const fromRight = useRef(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measured = el.offsetHeight - el.clientHeight;
    if (measured !== bar) setBar(measured);
    el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth - fromRight.current);
  });

  // A wheel turned over the plot pans it, as the plot has no other way to go.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // And so does dragging it.
  const drag = useRef<{ x: number; left: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // Not a touch, which pans natively, nor a press on the scrollbar itself.
    if (e.button !== 0 || e.pointerType === 'touch' || el.scrollWidth <= el.clientWidth) return;
    if (e.clientY > el.getBoundingClientRect().top + el.clientHeight) return;
    drag.current = { x: e.clientX, left: el.scrollLeft };
    el.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) e.currentTarget.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const scrolls = plotWidth > view.width - Y_AXIS_W + 0.5;
  const axis = grid.metric === 'qps' ? 'QPS' : `${grid.metric} latency, ${metricUnit(grid.metric)}`;

  return (
    <section className="graphpane" data-role="graph" aria-label="the curves of the ticked rows">
      <div className="panehead">
        <span className="pt">curves</span>
        <span className="pm">
          y = {axis}, log · x = recall
        </span>
        <span className="pn">
          {rows.length} row{rows.length === 1 ? '' : 's'}
          {ticked > rows.length ? ` · ${ticked - rows.length} more ticked under the filters` : ''}
        </span>
        {ticked > 0 && (
          <button type="button" className="link" data-act="plot-clear" title="untick every row" onClick={onClear}>
            clear
          </button>
        )}
      </div>
      <div className="graphbody">
        <div className="graphview" ref={viewRef}>
          {drawn && <CurveYAxis scale={scale} metric={grid.metric} />}
          <div
            className={'graphscroll' + (scrolls && drawn ? ' pans' : '') + (dragging ? ' dragging' : '')}
            ref={scroller}
            title={scrolls && drawn ? 'drag or turn the wheel to see lower recalls' : undefined}
            onScroll={(e) => {
              const el = e.currentTarget;
              fromRight.current = Math.max(0, el.scrollWidth - el.clientWidth - el.scrollLeft);
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {drawn && <CurveGraph data={data} metric={grid.metric} scale={scale} />}
          </div>
          {rows.length === 0 && (
            <div className="graphempty" data-role="graph-empty">
              {ticked === 0 ? (
                <>
                  <b>Tick a row in the table to draw its curves.</b>
                  <span>Tick several to read them on one graph · double-click a row to draw it alone</span>
                </>
              ) : (
                <>
                  <b>The ticked rows are hidden by the filters.</b>
                  <span>Clear the filters, or tick a row that is on screen</span>
                </>
              )}
            </div>
          )}
        </div>
        {rows.length > 0 && <GraphLegend data={data} />}
      </div>
    </section>
  );
}
