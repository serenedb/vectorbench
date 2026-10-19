/* The window's title bar: VectorBench identity, source link, service
 * switcher and the shared theme toggle — searchbench's header with this
 * product's names, drawn as the top strip of the one window rather than a card
 * of its own. Router context selects SPA links in the playground; standalone
 * uses anchors. */

import { Link, useInRouterContext } from 'react-router-dom';
import { findService, GithubIcon, ServiceSwitcher, SereneLogo, useTheme } from '@serenedb/ui';
import type { LinkRenderer, Theme } from '@serenedb/ui';
import { takeRuns, type BenchRunOption } from '../../entities/results/model/source';
import { PRODUCT_NAME, PRODUCT_PATH, SERVICE_ID, SOURCE_URL } from '../../shared/config';

const THEMES: readonly Theme[] = ['light', 'dark'];

/* How a run reads: `2026-10-12 · 3 participants`, and just `3 participants`
   when the results carry no date. The host formats the same string for its
   operator panel and keeps its own copy, because sharing one would mean a
   dependency on the host's package — and nothing here may need a backend, or
   the self-contained index.html stops opening over file://. */
function runLabel(run: BenchRunOption): string {
  const participants = `${run.participants} participant${run.participants === 1 ? '' : 's'}`;
  return run.date === null ? participants : `${run.date} · ${participants}`;
}

function repoLabel(href: string): string {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/?#]+)/.exec(href);
  return m ? `${m[1]}/${m[2]}` : 'GitHub';
}

export function BenchHeader() {
  const internal = useInRouterContext();
  const routerLink: LinkRenderer = ({ href, children, ...rest }) =>
    internal && href.startsWith('/') ? (
      <Link to={href} {...rest}>{children}</Link>
    ) : (
      <a href={href} {...rest}>{children}</a>
    );
  const { theme, setTheme } = useTheme();
  const service = findService(SERVICE_ID);
  const name = service?.name ?? PRODUCT_NAME;
  /* One run is the page saying what it is, not a choice, and the standalone
     offers none at all — in both cases the control would be a dead widget. */
  const runs = takeRuns();

  return (
    <div className="vb-titlebar">
      <div style={{ padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
        {routerLink({
          // Under a kit that predates the registry entry, still the product's
          // own path rather than the playground's front page.
          href: internal ? (service?.path ?? PRODUCT_PATH) : window.location.pathname,
          className: 'vb-brand',
          children: (
            <>
              <SereneLogo size={20} />
              <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-.01em', whiteSpace: 'nowrap' }}>
                SereneDB <span style={{ fontWeight: 400, color: 'var(--mut)' }}>/</span>{' '}
                <span style={{ color: 'var(--accent)' }}>{name}</span>
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 15,
                    background: 'var(--accent)',
                    marginLeft: 3,
                    verticalAlign: -2,
                    animation: 'vb-blink 1.1s steps(1) infinite',
                  }}
                />
              </span>
            </>
          ),
        })}

        <ServiceSwitcher currentId={SERVICE_ID} internal={internal} renderLink={routerLink} />

        {/* searchbench's run selector: beside the identity, because it names
            which benchmark is on screen. A native select, drawn in the page's
            theme through `color-scheme`; `value` tracks the host and never
            local state, because a pick loads another document and a control
            that moved on its own would claim a switch that has not happened. */}
        {runs !== null && runs.runs.length > 1 && (
          <select
            aria-label="Benchmark run"
            title="Which measurement of this benchmark to show"
            value={runs.currentId}
            onChange={(e) => runs.onSelect(e.currentTarget.value)}
            style={{
              border: '.5px solid var(--line)',
              borderRadius: 0,
              background: 'var(--inset)',
              color: 'var(--fg)',
              fontFamily: 'inherit',
              fontSize: 11,
              fontWeight: 700,
              padding: '4px 6px',
            }}
          >
            {runs.runs.map((run) => (
              <option key={run.id} value={run.id}>
                {runLabel(run)}
              </option>
            ))}
          </select>
        )}

        {/* The one thing on this strip that gives way: with the run selector
            beside it the row would otherwise outgrow the 1280px layout. */}
        <span
          style={{
            fontSize: 11,
            color: 'var(--mut)',
            marginLeft: 6,
            whiteSpace: 'nowrap',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          vector search in databases · one number per query, read off every engine's own recall curve
        </span>

        <a
          href={SOURCE_URL}
          target="_blank"
          rel="noopener"
          title="View source on GitHub"
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            border: '.5px solid var(--line)',
            background: 'var(--inset)',
            color: 'var(--fg)',
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          <GithubIcon size={14} className="shrink-0" />
          {repoLabel(SOURCE_URL)}
        </a>

        <div className="seg">
          {THEMES.map((t) => (
            <button
              key={t}
              type="button"
              className={theme === t ? 'on' : ''}
              data-act="theme"
              data-v={t}
              style={{ padding: '3px 8px', fontSize: '10.5px' }}
              onClick={() => setTheme(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
