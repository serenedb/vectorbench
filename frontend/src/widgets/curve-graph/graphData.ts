/* What a graph draws, computed from the same points and the same grid the
   table reads (DESIGN.md 4.2 rules 9–12): one series per participant and
   group, its Pareto frontier as the line, dominated points hollow, a vertical
   line per row at the row's recall, and every crossing marked at the value the
   cell shows. Rows sharing (filter, k) share the same points, so a second row
   of the same group only adds a vertical line. */

import {
  cellValue,
  frontier,
  gridCell,
  groupFor,
  participantColor,
  usablePoints,
  type Grid,
  type Point,
  type QueryRow,
  type ResultModel,
} from '../../entities/results';

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
  /** Index of the group among the drawn groups: picks the dash pattern. */
  groupIndex: number;
  points: SeriesPoint[];
  /** The frontier, recall ascending — the line. */
  line: Point[];
}

export interface RowMarker {
  qid: string;
  groupKey: string;
  recall: number;
  label: string;
}

export interface CrossingMark {
  pid: string;
  qid: string;
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
  /** Distinct group keys drawn, in order. */
  groups: string[];
  xMin: number;
  yMin: number;
  yMax: number;
}

export function buildGraphData(results: readonly ResultModel[], rows: readonly QueryRow[], grid: Grid): GraphData {
  const groups: string[] = [];
  for (const r of rows) if (!groups.includes(r.key)) groups.push(r.key);
  const series: Series[] = [];
  let yMin = Infinity;
  let yMax = -Infinity;
  let xMin = 1;
  for (const key of groups) {
    const row = rows.find((r) => r.key === key)!;
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
        groupIndex: groups.indexOf(key),
        points: pts.map((p) => ({ ...p, onFrontier: onFront.has(p) })),
        line: front,
      });
    }
  }
  const markers: RowMarker[] = rows.map((r) => ({
    qid: r.id,
    groupKey: r.key,
    recall: r.exact ? 1 : (r.recall as number),
    label: r.exact ? `${r.id} exact` : `${r.id} @ ${String(r.recall)}`,
  }));
  const crossings: CrossingMark[] = [];
  for (const r of rows) {
    for (const res of results) {
      const c = gridCell(grid, r.id, res.id);
      const v = cellValue(c);
      if (v === null || (c.status !== 'point' && c.status !== 'interpolated' && c.status !== 'above')) continue;
      crossings.push({ pid: res.id, qid: r.id, name: res.name, color: participantColor(res.id), recall: r.exact ? 1 : (r.recall as number), value: v, status: c.status });
      yMin = Math.min(yMin, v);
      yMax = Math.max(yMax, v);
    }
  }
  for (const m of markers) xMin = Math.min(xMin, m.recall);
  if (!Number.isFinite(yMin)) {
    yMin = 1;
    yMax = 10;
  }
  return { series, markers, crossings, groups, xMin: Math.min(0.8, Math.floor(xMin * 20) / 20), yMin, yMax };
}
