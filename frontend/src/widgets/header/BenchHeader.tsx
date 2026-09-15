/* VectorBench identity, source link, service switcher and the shared theme
 * toggle — searchbench's header with this product's names. Router context
 * selects SPA links in the playground; standalone uses anchors. */

import { Link, useInRouterContext } from 'react-router-dom';
import { findService, GithubIcon, ServiceSwitcher, SereneLogo, useTheme } from '@serenedb/ui';
import type { LinkRenderer, Theme } from '@serenedb/ui';
import { PRODUCT_NAME, SERVICE_ID, SOURCE_URL } from '../../shared/config';
import { Panel } from '../../shared/ui';

const THEMES: readonly Theme[] = ['light', 'dark'];

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

  return (
    <Panel className="vb-head">
      <div style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        {routerLink({
          href: internal ? (service?.path ?? '/') : window.location.pathname,
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

        <span style={{ fontSize: 11, color: 'var(--mut)', marginLeft: 6, whiteSpace: 'nowrap' }}>
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
    </Panel>
  );
}
