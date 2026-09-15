/* What a GENERAL row (or a section's memory row) opens: the load phases as a
   stacked bar with the unaccounted remainder as "other", the on-disk info
   list, the memory numbers, the full startup distribution. */

import { useMemo, type Dispatch, type ReactNode } from 'react';
import type { DatasetModel, ResultModel, Section } from '../../entities/results';
import { fmtBytes, fmtGB, fmtInt, fmtKnobs, fmtSec } from '../../shared/lib/format';
import type { BenchAction, HeaderRowKey } from '../../shared/model';
import { Modal } from '../../shared/ui';
import { Bars, OTHER_COLOR, PHASE_COLORS, StackedBars } from './Bars';

const TITLES: Record<HeaderRowKey, string> = {
  load: 'load time',
  disk: 'on disk',
  memload: 'max memory during load',
  startup: 'startup',
  'memq:nofilter': 'max memory during queries · NO FILTER',
  'memq:filtered': 'max memory during queries · FILTERED',
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function LoadDetail({ results }: { results: readonly ResultModel[] }): ReactNode {
  const phases: string[] = [];
  for (const r of results) for (const k of Object.keys(r.raw.load_phases ?? {})) if (!phases.includes(k)) phases.push(k);
  const color = (p: string) => (p === 'other' ? OTHER_COLOR : PHASE_COLORS[phases.indexOf(p) % PHASE_COLORS.length]);
  const items = results.map((r) => {
    const total = num(r.raw.load_time);
    const segments = Object.entries(r.raw.load_phases ?? {})
      .map(([name, v]) => ({ name, value: num(v) ?? 0 }))
      .filter((s) => s.value > 0);
    const sum = segments.reduce((s, x) => s + x.value, 0);
    if (total !== null && total - sum > 1e-9) segments.push({ name: 'other', value: total - sum });
    return { pid: r.id, name: r.name, total, segments };
  });
  return (
    <>
      <div className="sub">Wall time of the participant’s load script from empty engine to settled (ingest, index, compaction — all inside one timer). Phases are what the script reported in its VECTORBENCH_PHASES tag; “other” is the remainder.</div>
      <div className="h">seconds, shortest first</div>
      <StackedBars items={items} phaseColor={color} fmt={(v) => fmtSec(v) + ' s'} />
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--mut)', margin: '6px 0 0' }}>
        {[...phases, 'other'].map((p) => (
          <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span className="swatch" style={{ background: color(p) }} />
            {p}
          </span>
        ))}
      </div>
      <div className="h">phases per participant</div>
      <table className="dt">
        <thead>
          <tr>
            <th className="l">participant</th>
            {phases.map((p) => (
              <th key={p}>{p}</th>
            ))}
            <th>other</th>
            <th>total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.pid}>
              <td className="l">{it.name}</td>
              {phases.map((p) => {
                const s = it.segments.find((x) => x.name === p);
                return <td key={p}>{s ? fmtSec(s.value) : '—'}</td>;
              })}
              <td>{fmtSec(it.segments.find((x) => x.name === 'other')?.value ?? null)}</td>
              <td>{fmtSec(it.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function DiskDetail({ results }: { results: readonly ResultModel[] }): ReactNode {
  const items = results.map((r) => ({ pid: r.id, name: r.name, value: num(r.raw.disk_bytes) }));
  return (
    <>
      <div className="sub">`data-size` right after load: data plus index, as the engine stores them. The list under each participant is its VECTORBENCH_INFO tag, free form.</div>
      <div className="h">bytes on disk, smallest first</div>
      <Bars items={items} fmt={(v) => `${fmtGB(v)} GB · ${fmtBytes(v)}`} />
      {results.map((r) => (
        <div key={r.id}>
          <div className="h">{r.name}</div>
          <div className="kv">
            <span className="k">disk_bytes</span>
            <span>{r.raw.disk_bytes == null ? '—' : `${fmtInt(r.raw.disk_bytes)} (${fmtBytes(r.raw.disk_bytes)})`}</span>
            {Object.entries(r.raw.disk_info ?? {}).map(([k, v]) => (
              <span key={k} style={{ display: 'contents' }}>
                <span className="k">{k}</span>
                <span>{typeof v === 'number' ? fmtInt(v) + (k.endsWith('bytes') ? ` (${fmtBytes(v)})` : '') : typeof v === 'string' ? v : JSON.stringify(v)}</span>
              </span>
            ))}
            <span className="k">index params</span>
            <span>{fmtKnobs(r.raw.index?.params)}</span>
          </div>
        </div>
      ))}
    </>
  );
}

function MemoryDetail({ results, field, note }: { results: readonly ResultModel[]; field: 'load' | 'unfiltered' | 'filtered'; note: string }): ReactNode {
  const items = results.map((r) => ({ pid: r.id, name: r.name, value: num(r.raw.memory_peak?.[field]) }));
  return (
    <>
      <div className="sub">{note}</div>
      <div className="h">bytes, smallest first</div>
      <Bars items={items} fmt={(v) => `${fmtGB(v)} GB · ${fmtBytes(v)}`} />
    </>
  );
}

function GroupMemoryTable({ results, section }: { results: readonly ResultModel[]; section: Section }): ReactNode {
  const keys: string[] = [];
  for (const r of results) for (const g of r.groups.values()) if (g.filter === 'none' === (section === 'nofilter') && !keys.includes(g.key)) keys.push(g.key);
  if (!keys.length) return null;
  return (
    <>
      <div className="h">memory.peak per group (max over both views)</div>
      <table className="dt">
        <thead>
          <tr>
            <th className="l">group</th>
            {results.map((r) => (
              <th key={r.id}>{r.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <td className="l">{k}</td>
              {results.map((r) => {
                const vals = (['throughput', 'latency'] as const).map((v) => num(r.groups.get(v + '|' + k)?.memory_peak)).filter((x): x is number => x !== null);
                const statuses = (['throughput', 'latency'] as const).map((v) => r.groups.get(v + '|' + k)?.status).filter(Boolean);
                return <td key={r.id}>{vals.length ? fmtGB(Math.max(...vals)) + ' GB' : statuses[0] ?? '—'}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function StartupDetail({ results }: { results: readonly ResultModel[] }): ReactNode {
  const list = [...results].sort((a, b) => (num(a.raw.startup?.avg) ?? Infinity) - (num(b.raw.startup?.avg) ?? Infinity));
  return (
    <>
      <div className="sub">The engine is restarted before every group in every view; each restart is one sample, from invoking `start` to the first successful `check`, polled every 100 ms. Seconds.</div>
      <table className="dt" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th className="l">participant</th>
            <th>n</th>
            <th>min</th>
            <th>avg</th>
            <th>p50</th>
            <th>p95</th>
            <th>p99</th>
            <th>max</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => {
            const s = r.raw.startup;
            return (
              <tr key={r.id}>
                <td className="l">{r.name}</td>
                <td>{s ? fmtInt(s.n) : '—'}</td>
                <td>{fmtSec(s?.min)}</td>
                <td className="hl">{fmtSec(s?.avg)}</td>
                <td>{fmtSec(s?.p50)}</td>
                <td>{fmtSec(s?.p95)}</td>
                <td>{fmtSec(s?.p99)}</td>
                <td>{fmtSec(s?.max)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

export function HeaderDetailModal({ dataset, results, row, dispatch }: { dataset: DatasetModel; results: readonly ResultModel[]; row: HeaderRowKey; dispatch: Dispatch<BenchAction> }): ReactNode {
  const close = () => dispatch({ type: 'detail-close' });
  const body = useMemo(() => {
    switch (row) {
      case 'load':
        return <LoadDetail results={results} />;
      case 'disk':
        return <DiskDetail results={results} />;
      case 'memload':
        return <MemoryDetail results={results} field="load" note="cgroup memory.peak of the engine container over the load phase, reset before it." />;
      case 'startup':
        return <StartupDetail results={results} />;
      case 'memq:nofilter':
        return (
          <>
            <MemoryDetail results={results} field="unfiltered" note="cgroup memory.peak over every no-filter group, both views; shown, never scored." />
            <GroupMemoryTable results={results} section="nofilter" />
          </>
        );
      case 'memq:filtered':
        return (
          <>
            <MemoryDetail results={results} field="filtered" note="cgroup memory.peak over every filtered group, both views; shown, never scored." />
            <GroupMemoryTable results={results} section="filtered" />
          </>
        );
    }
  }, [row, results]);
  return (
    <Modal kicker="detail" title={TITLES[row]} meta={dataset.id} role="header-detail" width="min(900px, 92vw)" onClose={close}>
      {body}
    </Modal>
  );
}
