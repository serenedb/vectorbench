/* Participant colours and the ClickBench cell ramp.

   Copied from searchbench/frontend/src/shared/lib/color.ts with two changes.
   A participant is a database plus an index family, so two SereneDB
   participants can sit side by side: SereneDB participants take a ramp of the
   brand's purple, in sorted participant-id order. And because purple is
   SereneDB's, no one else gets a purple: everyone else takes a stable slot of
   a palette without one, keyed off its position in the sorted list of the
   other participants. Stable is the point: a participant keeps its colour in
   the legend, every graph and every detail, and adding a dataset must not
   repaint the ones already published. */

export const PALETTE = [
  '#3386ff',
  '#5ed29a',
  '#ffb454',
  '#e06c9f',
  '#7fd7e0',
  '#d0c05a',
  '#ff7b6b',
  '#f29e7b',
  '#2fb5a4',
  '#a3a8b4',
] as const;

export const SERENEDB_SYSTEM = 'SereneDB';
export const SERENEDB_COLORS = ['#895af8', '#b49cff', '#6b3fd9', '#c86bf2'] as const;

/**
 * participant id → colour, for every participant in the benchmark at once.
 * @param participants every participant, any order; only `id` and `system` are read
 */
export function assignColors(
  participants: readonly { id: string; system: string }[],
): Map<string, string> {
  const sorted = [...participants].sort((a, b) => a.id.localeCompare(b.id));
  const out = new Map<string, string>();
  let own = 0;
  let slot = 0;
  for (const p of sorted) {
    if (p.system === SERENEDB_SYSTEM) out.set(p.id, SERENEDB_COLORS[own++ % SERENEDB_COLORS.length]);
    else out.set(p.id, PALETTE[slot++ % PALETTE.length]);
  }
  return out;
}

/**
 * Cell background: green at the row's best (ratio 1), red at 8× and beyond, on
 * a log2 ramp — ClickBench's colouring, searchbench's numbers. Returns
 * `var(--card)` for a non-positive ratio so an empty cell blends in.
 */
export function ratioBg(ratio: number | null | undefined): string {
  if (!(typeof ratio === 'number' && ratio > 0)) return 'var(--card)';
  const t = Math.min(1, Math.log2(ratio) / Math.log2(8));
  return `hsl(${(120 * (1 - t)).toFixed(0)}, 62%, ${(78 - 16 * t).toFixed(0)}%)`;
}
