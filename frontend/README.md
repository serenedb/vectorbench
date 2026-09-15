# VectorBench frontend

The React results page exports `ProductApp` through `@vectorbench/frontend`.
It is the SearchBench frontend's architecture applied to vector search: one
number per query and participant, read off the participant's own recall curve
(docs/contracts.md sections 9–11, DESIGN.md sections 2 and 7). It has two
entry points and one set of components:

- `src/standalone.tsx` supplies `results.json`, mounts React and owns the theme
  (light by default, dark through the platform `ThemeProvider`).
- `src/index.ts` exports the product for a host such as SereneDB Playground.
  It does not import the standalone JSON or mount a second React root.

All npm configuration, dependencies and commands live in `frontend/`. The
design-kit submodule is pinned at `frontend/deps/serene-design`.

```bash
git submodule update --init --recursive
cd frontend
npm ci
npm run dev        # Vite dev server on http://127.0.0.1:5173, serving dev.html
npm run build      # one self-contained frontend/index.html
```

`dev.html` is Vite's development entry. The dev server also serves it at `/`
and `/index.html`, so development never displays an old committed build.

`npm run build` creates **one self-contained `frontend/index.html`**, including
JS, CSS, fonts and the current `frontend/results.json` (its sha256 is written
to a `<meta name="vectorbench-results-sha256">` tag). Commit the HTML. It can
be opened with a double click, copied by itself, or hosted as a static page.
No CDN, module fetch or JSON fetch is needed to render it. URL state and the
theme toggle work in both modes.

## What the page computes

`results.json` holds the record: the family blocks (query lists) and one
result object per participant and dataset size, each a list of groups with
their measured points. Everything else is derived in the browser, so the table,
the graph and the detail can never disagree:

| where | what |
|---|---|
| `src/entities/results/model/frontier.ts` | Pareto frontier, crossing, density rule — contracts section 9, identical to `lib/vectorbench/frontier.py` and checked against the same `frontier_cases.json` |
| `model/model.ts` | strict loader (`buildBenchmark`): families, datasets, rows into sections, chip tags, the default dataset (the largest size every participant of the first family has a result for) |
| `model/cells.ts` | row → group (`"<filter>/<k>"`, `"exact/<filter>/<k>"`) for the selected view, the cell per participant, the grid per (dataset, view, metric) |
| `model/scores.ts` | score (geomean of ratios to the row's best over the visible rows) and coverage per section — contracts section 10 — and the column order |
| `model/rows.ts` | the chips: `filter:<case base>`, `k:<k>`, `recall:<r|exact>`; OR within a dimension, AND across |
| `src/widgets/curve-graph/*` | the graph under a row and the full-screen graph: frontier lines, hollow dominated points, the row's recall line, every crossing |
| `src/widgets/detail/*` | the cell detail (statement, every point, the bracket) and the GENERAL details (load phases with "other", on-disk info, memory, startup distribution) |

The `filter` chips group cases by predicate (`eq` covers eq-10 / eq-1 /
eq-0.1), as the mock in DESIGN.md section 2 shows.

## Refresh results

`vectorbench assemble` (lib/vectorbench/assemble.py) reads every
`*/results/*.json` and the family definitions and writes `frontend/results.json`.
Then run `npm run build` in `frontend/` and commit the JSON and HTML together.

Until real results exist the committed `results.json` is **synthetic**, written by

```bash
npm run sample     # node scripts/sample-results.mjs
```

which is deterministic (byte-identical run to run) and follows contracts
sections 8 and 11 exactly, plus a top-level `"sample": true` that the page shows
as a banner. `vectorbench assemble` overwrites the file and the banner disappears.

## Playground integration

The host provides results before dynamically importing the product:

```ts
const { provideResults } = await import('@vectorbench/frontend/results');
provideResults(resultsJson);   // the object `vectorbench assemble` writes
const { ProductApp, path, serviceId } = await import('@vectorbench/frontend');
```

The host supplies `ThemeProvider` and its React Router context. Inside that
context, header links use the host router; standalone links use ordinary
anchors and absolute service URLs. Styles are scoped under
`[data-product='vectorbench']`; `path` is `/vectorbench` and `serviceId` is
`vectorbench` (not yet in the kit's service registry — the header falls back to
the product name until it is).

## URL state

Every selector and chip is encoded in `?s=<base64url json>`; readable
overrides work next to it and are canonicalised on the next render:
`?dataset=wiki-v3-1024-100k&view=latency&metric=p99&cells=absolute&chips=k:10,filter:eq&sort=filtered&row=V14&graph=V14,V35&theme=dark`.
Modals are never encoded.

## Checks

From `frontend/`:

```bash
npm run typecheck
npx playwright install chromium   # once, for the browser check
npm test
```

`npm test` runs `tests/*.test.mjs` with node's test runner (node strips the
TypeScript types itself, so the model is tested from source):

- `frontier.test.mjs` — every shared vector in
  `lib/vectorbench/testdata/frontier_cases.json`, plus `cell()` statuses;
- `model.test.mjs` — the generated sample through the loader: cells, scores,
  coverage, column order, chips, the loader's strictness, the URL codec;
- `offline.test.mjs` — the committed `index.html` over `file://` with the
  network disabled: table, row graph, full-screen graph, cell and header
  details, selectors, theme, reload, and zero network requests.

Rebuild before running the browser test after changing source or results. On a
host where Playwright's Chromium cannot start for lack of system libraries and
`npx playwright install-deps` is not an option (no sudo), download the
packages with `apt-get download`, `dpkg -x` them into a directory and run the
tests with `LD_LIBRARY_PATH=<dir>/usr/lib/x86_64-linux-gnu npm test`.
