/* The benchmark, as widgets and pages see it. */

export type { Query, RawFamily, RawGroup, RawPoint, RawResult, RawResults, Recall, Stats, View } from './model/types';
export type { Cell, Crossing, Direction, Point } from './model/frontier';
export { EPS, GAP_LIMIT, cell, cellValue, crossing, dominated, frontier, usablePoints } from './model/frontier';
export type { GroupRowModel, ParticipantCurve } from './model/groupRows';
export { groupRows } from './model/groupRows';
export type {
  Benchmark,
  ChipGroups,
  DatasetModel,
  FamilyModel,
  ParticipantInfo,
  QueryRow,
  ResultModel,
  Section,
  SizeInfo,
} from './model/model';
export {
  ContractError,
  SECTIONS,
  SECTION_TITLES,
  VIEWS,
  buildBenchmark,
  caseBase,
  defaultDatasetOfFamily,
  groupKey,
  latencyClients,
  pickDefaultDataset,
  splitDatasetId,
} from './model/model';
export type { Grid, LatencyMetric, Metric } from './model/cells';
export {
  LATENCY_METRICS,
  cellFor,
  computeGrid,
  directionOf,
  failLabel,
  gridCell,
  groupFor,
  isLatencyMetric,
  isOk,
  metricFor,
  statusLabel,
} from './model/cells';
export type { Coverage, SectionScores } from './model/scores';
export { orderResults, ratioTo, sectionScores, sectionScoresByGroup } from './model/scores';
export type { ChipDimension } from './model/rows';
export { CHIP_DIMENSIONS, allChipTags, chipLabel, chipTag, rowPasses, rowTitle, tableOrder, visibleRows } from './model/rows';
export { BENCH, BENCH_ERROR, datasetById, participantColor } from './model/dataset';
