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
theme toggle work in both modes. The embedded face is Urbanist from the design
kit; its licence is `Urbanist-OFL.txt` next to the HTML.

## Layout

One window, laid out like a desktop application rather than a page of cards:
a title bar, a toolbar, the table and the graph side by side, a status bar.

| part | what it holds |
|---|---|
| title bar | the product, the service switcher, the run selector when the host offers several benchmarks, the source link, the theme |
| toolbar | the dataset (a menu: one row per `<family>-<size>` with results), the view (Throughput / Latency) and, in the Latency view, the statistic; then **Filter** — the row chips (filter case, k, recall) and the participants — and **Display** — rows by group / by recall bar, cells relative / absolute |
| table (left) | the grid; every query row (group row, in the group reading) is a checkbox |
| graph (right) | the curves of the ticked rows, on a plot 80% of the screen wide that scrolls under a pinned y axis |
| status bar | what is on screen, the gestures, the colour ramp |

What is changed while comparing — dataset, view, statistic — sits in the
toolbar; what is set once — chips, participants, the row reading, the cell
format — waits in the two menus, and while they are closed the toolbar still
says what is on: a count on Filter and a pill per chip or hidden participant,
each removable with a click.

The table is the list the graph draws from. A click on a row ticks it and its
curves join the graph; a double-click draws that row alone, a shift-click
ticks every row from the last one clicked, and the graph's `clear` unticks
them all. With nothing picked yet the first row is ticked. On the keyboard ↑ ↓
walk the row labels and Space ticks the one with focus. In the group reading a
group is drawn at the common bar its cells are read at; switching the reading
keeps the ticks (a group stands for its bars, a bar for its group).

A section's rows read in blocks, one per filter case, a firmer rule above
each, and every row is named by what it asks — k, then the case:
`k=10 · eq-10`, `k=100 · eq-10`. k leads because it is what changes inside a
block; NO FILTER rows name no case, as the heading does. A family that lists a
case's extra bars at the end of its query list (eq-1 at 0.99, eq-1 exact) has
them joined to that case's block. The group key (`eq-10/10`) says what the
label does and is not printed.

In the group reading a label carries no recall bar: where a row is read is the
graph's dashed line, and the label's tooltip. It still says `exact`, and
`no common bar` where every participant cannot be read at one. A cell prints
its number and, after it, `@ 0.997` — the highest recall that participant's
curve reaches; the number itself is read at the row's common bar, the same for
every participant of the row. In the bar reading the label keeps its bar, as
the bar is what tells V01, V02 and V03 apart.

Every participant keeps one colour in the table head, the menus and the graph:
SereneDB the brand's purple, the others a palette with no purple in it
(`src/shared/lib/color.ts`).

The table is kept narrow so the graph gets the width: labels say each thing
once, and a participant's column is as wide as the longest word of its name,
which wraps onto a second line in the header.

The plot is 80% of the screen wide, which beside the table is wider than its
pane: what a reader compares sits close to recall 1, and a plot squeezed into
the pane crowds exactly that part. It opens scrolled to recall 1, its y axis
stays put, and it pans by the scrollbar, the wheel or a drag; ticking rows or
moving the rule keeps where the reader left it.

The rule between the panes drags (← → once focused); until it is moved the
table takes the width its columns want, at most 62%. The width picked is kept
in this browser; a double-click on the rule forgets it.

Hiding a participant takes it out of the comparison, as SearchBench measures
every ratio against the fastest engine on screen: each row's best, each
group's common recall bar, the scores, the coverage and the column order are
computed over the participants shown. One click never hides the last of them.

Unlike SearchBench there is no query panel under the table: a cell and a
GENERAL row open their detail as a modal, and the GENERAL labels carry an
arrow to the top right to say so. Escape closes a detail, or an open menu
first.

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
| `src/widgets/curve-graph/*` | the graph pane: frontier lines, hollow dominated points, each ticked row's recall line, every crossing |
| `src/widgets/detail/*` | the cell detail (statement, every point, the bracket) and the GENERAL details (load phases with "other", on-disk info, memory, startup distribution) |
| `src/widgets/toolbar/*` | the toolbar and its menus: dataset, view and statistic; Filter (chips, participants), Display (rows, cells) |
| `src/pages/bench/model/selection.ts` | the ticked rows in the reading on screen, and the first row when nothing is picked yet |

The `filter` chips group cases by predicate (`eq` covers eq-10 / eq-1 /
eq-0.1), as the mock in DESIGN.md section 2 shows.

## Refresh results

`vectorbench assemble` (lib/vectorbench/assemble.py) reads every
`*/results/*.json` and the family definitions and writes `frontend/results.json`.
Then run `npm run build` in `frontend/` and commit the JSON and HTML together.

`--dataset <family>-<size>` (repeatable) narrows the page to those datasets and
their families; the other result files stay in the repository, and every
`results.json` ever committed stays in the playground's history. The committed
page is assembled that way, from `wiki-v3-1024-50m` alone:

```bash
.venv/bin/python -m vectorbench.cli assemble --dataset wiki-v3-1024-50m
```

The page draws what was measured. A row nobody ran at a dataset's size is left
out — of the table, the chips and the scores — and a section with no row left
is not drawn; a row someone recorded, even as unsupported, stays. The Latency
view is off on a dataset where no participant measured latency.

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

A host that keeps several benchmarks for one page (SereneDB Playground's
operator panel does) can also hand over the list, before the same import:

```ts
const { provideResults, provideRuns } = await import('@vectorbench/frontend/results');
provideResults(resultsJson);
provideRuns({ runs, currentId, onSelect });   // runs: { id, date, participants }[]
```

The header then offers them in a selector labelled `2026-10-12 · 3
participants`. Picking one only calls `onSelect`: the results are frozen when
the product's modules are first imported, so showing another run is a new
document, and that is the host's to load. The standalone build never calls
`provideRuns`, and the selector does not render.

The host supplies `ThemeProvider` and its React Router context. Inside that
context, header links use the host router; standalone links use ordinary
anchors and absolute service URLs. Styles are scoped under
`[data-product='vectorbench']`; `path` is `/vectorbench` and `serviceId` is
`vectorbench`, listed in the kit's service registry, which is where the header
and the switcher take its name from.

SereneDB Playground carries this repository as the `products/vectorbench`
submodule, compiles `frontend/` into its single web build, and serves this
`results.json` as a static file at `/vectorbench-data/results.json` that its
loader fetches before importing the product. A new benchmark reaches the
playground as a submodule bump; nothing in the playground has to change.

## URL state

Every selector and chip is encoded in `?s=<base64url json>`; readable
overrides work next to it and are canonicalised on the next render:
`?dataset=wiki-v3-1024-100k&view=latency&metric=p99&cells=absolute&rows=bars&chips=k:10,filter:eq&hidden=qdrant-hnsw&sort=filtered&graph=V14,V35&theme=dark`
(`hidden` lists participant ids switched off; `graph` the ticked rows, query
ids or group keys in either reading, `-` for none ticked). A link from before
the graph moved beside the table still opens: its `row=` is ticked, and
`expanded=` is ignored. Modals and the split are never encoded.

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
  network disabled: the window (table and graph side by side, the rule that
  drags), the menus, ticking rows by click, double-click and keyboard, cell
  and header details, the selectors and the reading switch, the dataset
  switch, theme, reload, and zero network requests.

Rebuild before running the browser test after changing source or results. On a
host where Playwright's Chromium cannot start for lack of system libraries and
`npx playwright install-deps` is not an option (no sudo), download the
packages with `apt-get download`, `dpkg -x` them into a directory and run the
tests with `LD_LIBRARY_PATH=<dir>/usr/lib/x86_64-linux-gnu npm test`.
