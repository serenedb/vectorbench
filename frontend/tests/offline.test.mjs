/* The committed HTML, opened over file:// with the network disabled: it
   renders the table from its inlined results, a row click opens the graph, a
   cell click opens the detail, the selectors and the theme work, and nothing
   is fetched. Rebuild (npm run build) before running after changing source or
   results. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('committed HTML renders, graphs and details work over file:// without network', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ offline: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    const network = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (/^https?:/.test(request.url())) network.push(request.url());
    });
    const html = new URL('../index.html', import.meta.url);
    const resultsBytes = await readFile(new URL('../results.json', import.meta.url));
    const results = JSON.parse(resultsBytes.toString('utf8'));
    await page.goto(html.href);
    assert.equal(
      await page.locator('meta[name="vectorbench-results-sha256"]').getAttribute('content'),
      createHash('sha256').update(resultsBytes).digest('hex'),
      'Rebuild index.html after changing results.json',
    );
    await page.locator('.vb-app').waitFor();
    const body = () => page.locator('body').innerText();

    // the table: every participant of the default dataset is a column, the three sections are there
    const text = await body();
    assert.ok(text.includes('VectorBench'));
    for (const s of ['GENERAL', 'NO FILTER', 'FILTERED', 'load time', 'score', 'coverage']) assert.ok(text.includes(s), s);
    const names = new Set(results.results.map((r) => r.name));
    for (const n of names) assert.ok(text.includes(n), n);
    if (results.sample) await page.locator('[data-role="sample-banner"]').waitFor();
    const firstRow = results.families[Object.keys(results.families)[0]].queries[0].id;
    assert.ok(text.includes(firstRow));

    // a row click opens the inline graph with one line per participant and the dashed row line
    await page.locator(`[data-act="row"][data-id="${firstRow}"]`).click();
    const graph = page.locator('[data-role="inline-graph"]');
    await graph.waitFor();
    assert.ok((await graph.locator('svg.curve-graph polyline').count()) >= 1, 'at least one curve');
    assert.ok((await graph.locator('svg.curve-graph circle').count()) >= 2, 'measured points');
    assert.ok((await graph.locator('svg.curve-graph rect').count()) >= 1, 'a crossing marker');
    assert.equal(await page.locator(`[data-act="row"][data-id="${firstRow}"]`).getAttribute('class'), 'rowlab open');
    // the URL remembers the open row
    assert.ok(page.url().includes('?s='));

    // full screen: another row can be toggled in
    await graph.locator('[data-act="graph-open"]').click();
    const full = page.locator('[data-role="full-graph"]');
    await full.waitFor();
    const secondRow = results.families[Object.keys(results.families)[0]].queries[1].id;
    await full.locator(`[data-act="graph-toggle"][data-id="${secondRow}"]`).check();
    assert.ok((await full.locator('svg.curve-graph line[style*="dasharray"], svg.curve-graph line').count()) >= 2);
    await page.keyboard.press('Escape');
    await full.waitFor({ state: 'detached' });

    // a cell click opens the detail with the points table
    const cell = page.locator(`[data-act="cell"][data-id="${firstRow}"]`).first();
    await cell.click();
    const detail = page.locator('[data-role="cell-detail"]');
    await detail.waitFor();
    const dtext = await detail.innerText();
    assert.ok(dtext.includes('points'), 'points table');
    assert.ok(dtext.includes('statement'), 'statement block');
    assert.ok(dtext.includes('bracket') || dtext.includes('point'), 'the reading');
    await detail.locator('[data-act="modal-close"]').click();
    await detail.waitFor({ state: 'detached' });

    // a GENERAL header click opens the load-phases detail
    await page.locator('[data-act="header"][data-key="load"]').click();
    const hd = page.locator('[data-role="header-detail"]');
    await hd.waitFor();
    assert.ok((await hd.innerText()).includes('other'));
    await page.keyboard.press('Escape');
    await hd.waitFor({ state: 'detached' });

    // selectors: latency view shows the metric strip; absolute cells print units; the filtered score re-sorts
    await page.locator('[data-act="view"][data-v="latency"]').click();
    await page.locator('[data-act="metric"][data-v="p99"]').click();
    assert.equal(await page.locator('[data-act="metric"][data-v="p99"]').getAttribute('class'), 'on');
    await page.locator('[data-act="cells"][data-v="absolute"]').click();
    await page.locator('[data-act="sort"][data-section="filtered"]').first().click();
    // chips narrow the rows and are reflected in the URL
    await page.locator('[data-act="chip"][data-tag="k:10"]').click();
    assert.ok(!(await body()).includes('k=100 ·'), 'k=100 rows hidden');
    await page.locator('[data-act="clear-chips"]').click();

    // theme: the platform toggle flips the html class
    await page.locator('[data-act="theme"][data-v="dark"]').click();
    assert.ok(await page.locator('html').evaluate((el) => el.classList.contains('dark')));

    // the state survives a reload through the URL
    await page.reload();
    await page.locator('.vb-app').waitFor();
    assert.equal(await page.locator('[data-act="view"][data-v="latency"]').getAttribute('class'), 'on');
    assert.equal(await page.locator('[data-act="cells"][data-v="absolute"]').getAttribute('class'), 'on');
    assert.ok(await page.locator('html').evaluate((el) => el.classList.contains('dark')));

    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    await context.close();
  } finally {
    await browser.close();
  }
});
