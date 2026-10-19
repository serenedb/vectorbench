/* What a graph draws, computed from the same points and the same readings the
   table shows (DESIGN.md 4.2 rules 9–12): one series per participant and
   group, its Pareto frontier as the line, dominated points hollow, a vertical
   line per row at the recall the row is read at, and every crossing marked at
   the value the cell shows. Rows sharing (filter, k) share the same points, so
   a second row of the same group only adds a vertical line.

   A row is either reading of the table: a query row stands at its own recall
   bar and its marks are the grid's cells; a group row stands at the common bar
   the group is read at, and its marks are each participant's value there. */

import {
  cellValue,
  frontier,
  gridCell,
  groupFor,
  participantColor,
  rowTitle,
  usablePoints,
  type GroupRowModel,
  type Grid,
  type Point,
  type QueryRow,
  type ResultModel,
} from '../../entities/results';

export interface PlotMark {
  pid: string;
  value: number;
  status: 'point' | 'interpolated' | 'above';
}

/** One ticked row of the table, as the graph reads it. */
export interface PlotRow {
  /** The row: a query id, or a group key. */
  id: string;
  /** What its marker says, as the table names the row: the query id, or the group's title. */
  label: string;
  /** A query row of the group, through which each participant's points are found. */
  query: QueryRow;
  /** Where the row is read; null when it has no bar every participant can be read at. */
  recall: number | null;
  exact: boolean;
  /** The values the row's cells show, marked on the curves they were read off. */
  marks: readonly PlotMark[];
}

/** A query row of the bar reading: its own recall, its cells from the grid. */
export function queryPlotRow(row: QueryRow, results: readonly ResultModel[], grid: Grid): PlotRow {
  const marks: PlotMark[] = [];
  for (const res of results) {
    const c = gridCell(grid, row.id, res.id);
    const v = cellValue(c);
    if (v === null || (c.status !== 'point' && c.status !== 'interpolated' && c.status !== 'above')) continue;
    marks.push({ pid: res.id, value: v, status: c.status });
  }
  return { id: row.id, label: row.id, query: row, recall: row.exact ? 1 : (row.recall as number), exact: row.exact, marks };
}

/** A group row: the common bar it is read at, each participant's value there.
    A row with a quality gap prints reach rather than speed, so it marks nothing. */
export function groupPlotRow(group: GroupRowModel, query: QueryRow): PlotRow {
  const marks: PlotMark[] = [];
  if (!group.qualityGap) for (const c of group.curves) if (c.value !== null) marks.push({ pid: c.pid, value: c.value, status: 'interpolated' });
  const recall = group.exact ? (group.curves.some((c) => c.value !== null) ? 1 : null) : group.bar;
  return { id: group.key, label: rowTitle(group), query, recall, exact: group.exact, marks: recall === null ? [] : marks };
}

export interface SeriesPoint extends Point {
  onFrontier: boolean;
}

export interface Series {
  /** `${pid}|${groupKey}` */
  id: string;
  pid: string;
  name: string;
  color: string;
  groupKey: string;
  groupTitle: string;
  /** Index of the group among the drawn groups: picks the dash pattern. */
  groupIndex: number;
  points: SeriesPoint[];
  /** The frontier, recall ascending — the line. */
  line: Point[];
}

export interface RowMarker {
  /** The row's id: a query id, or a group key. */
  qid: string;
  label: string;
  groupKey: string;
  recall: number;
  exact: boolean;
}

export interface CrossingMark {
  pid: string;
  qid: string;
  /** The row as its marker names it. */
  label: string;
  name: string;
  color: string;
  recall: number;
  value: number;
  status: 'point' | 'interpolated' | 'above';
}

export interface GraphData {
  series: Series[];
  markers: RowMarker[];
  crossings: CrossingMark[];
  /** The groups drawn, in order, with what the legend calls each. */
  groups: { key: string; title: string }[];
  xMin: number;
  yMin: number;
  yMax: number;
}

export function buildGraphData(results: readonly ResultModel[], rows: readonly PlotRow[], grid: Grid): GraphData {
  const groups: { key: string; title: string }[] = [];
  for (const r of rows) {
    if (groups.some((g) => g.key === r.query.key)) continue;
    groups.push({ key: r.query.key, title: rowTitle(r.query) + (r.query.exact ? ' · exact' : '') });
  }
  const series: Series[] = [];
  let yMin = Infinity;
  let yMax = -Infinity;
  let xMin = 1;
  for (const [groupIndex, { key, title }] of groups.entries()) {
    const row = rows.find((r) => r.query.key === key)!.query;
    for (const res of results) {
      const g = groupFor(res, row, grid.view);
      if (!g || g.status !== 'ok') continue;
      const pts = usablePoints(g.points ?? [], grid.metric);
      if (!pts.length) continue;
      const front = frontier(pts, grid.direction);
      const onFront = new Set(front);
      for (const p of pts) {
        yMin = Math.min(yMin, p.value);
        yMax = Math.max(yMax, p.value);
        xMin = Math.min(xMin, p.recall);
      }
      series.push({
        id: `${res.id}|${key}`,
        pid: res.id,
        name: res.name,
        color: participantColor(res.id),
        groupKey: key,
        groupTitle: title,
        groupIndex,
        points: pts.map((p) => ({ ...p, onFrontier: onFront.has(p) })),
        line: front,
      });
    }
  }
  const markers: RowMarker[] = [];
  const crossings: CrossingMark[] = [];
  for (const r of rows) {
    if (r.recall === null) continue;
    markers.push({ qid: r.id, label: r.label, groupKey: r.query.key, recall: r.recall, exact: r.exact });
    xMin = Math.min(xMin, r.recall);
    for (const m of r.marks) {
      const res = results.find((x) => x.id === m.pid);
      if (!res) continue;
      crossings.push({ pid: m.pid, qid: r.id, label: r.label, name: res.name, color: participantColor(m.pid), recall: r.recall, value: m.value, status: m.status });
      yMin = Math.min(yMin, m.value);
      yMax = Math.max(yMax, m.value);
    }
  }
  if (!Number.isFinite(yMin)) {
    yMin = 1;
    yMax = 10;
  }
  return { series, markers, crossings, groups, xMin: Math.min(0.8, Math.floor(xMin * 20) / 20), yMin, yMax };
}
