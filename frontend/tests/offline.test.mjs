/* The committed HTML, opened over file:// with the network disabled: it
   renders one window — toolbar, table, graph, status bar — from its inlined
   results; ticking rows in the table draws them on the graph beside it; a cell
   click opens the detail; the toolbar's menus, the selectors, the dataset
   switch, the split and the theme work; the state survives a reload; and
   nothing is fetched. Rebuild (npm run build) before running after changing
   source or results. */
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

    // What was measured decides what is drawn: a section nobody ran is left out, and the Latency
    // view is off where nobody measured latency. Read it off the same file the page was built from.
    const measured = (pred) => results.results.some((r) => r.groups.some(pred));
    const hasFiltered = measured((g) => g.filter !== 'none');
    const hasLatency = measured((g) => g.view === 'latency');

    // the table: every participant of the default dataset is a column, the sections are there
    const text = await body();
    assert.ok(text.includes('VectorBench'));
    for (const s of ['GENERAL', 'NO FILTER', 'load time', 'score', 'coverage']) assert.ok(text.includes(s), s);
    assert.equal(text.includes('FILTERED'), hasFiltered, 'a section is drawn when somebody ran it');
    const names = new Set(results.results.map((r) => r.name));
    for (const n of names) assert.ok(text.includes(n), n);
    if (results.sample) await page.locator('[data-role="sample-banner"]').waitFor();

    // the window: table and graph side by side, the status bar one line, no sidebar
    const table = page.locator('[data-role="table"]');
    const graph = page.locator('[data-role="graph"]');
    const tableBox = await table.boundingBox();
    const graphBox = await graph.boundingBox();
    assert.ok(tableBox.x + tableBox.width <= graphBox.x + 1, 'the graph is right of the table');
    assert.ok(Math.abs(tableBox.y - graphBox.y) < 2 && Math.abs(tableBox.height - graphBox.height) < 2, 'side by side, one height');
    assert.ok(graphBox.width > 400, 'the graph has room');
    assert.ok((await page.locator('[data-role="status"]').evaluate((el) => el.getBoundingClientRect().height)) < 30, 'the status bar is one line');
    assert.equal(await page.locator('[data-act="dataset"]').count(), 0, 'no sidebar: the datasets wait in a menu');

    // the rule between them drags, and a double-click puts it back
    const rule = await page.locator('.splitter').boundingBox();
    await page.mouse.move(rule.x + rule.width / 2, rule.y + 200);
    await page.mouse.down();
    // to the right: a table of two participants is already near its narrowest
    await page.mouse.move(rule.x + 120, rule.y + 200, { steps: 4 });
    await page.mouse.up();
    assert.ok((await table.boundingBox()).width > tableBox.width + 100, 'the rule drags');
    await page.locator('.splitter').dblclick();
    assert.ok(Math.abs((await table.boundingBox()).width - tableBox.width) < 2, 'a double-click resets it');

    // the dataset menu: one row per dataset size with results
    const datasets = [...new Set(results.results.map((r) => r.dataset))];
    await page.locator('[data-act="dataset-menu"]').click();
    assert.equal(await page.locator('[data-act="dataset"]').count(), datasets.length, 'a row per dataset with results');
    await page.keyboard.press('Escape');
    await page.locator('[data-role="dataset-menu"]').waitFor({ state: 'detached' });

    // the filter menu: participants in column order; a click takes a column out, never the last one
    const columns = await page.$$eval('.pcol[data-pid]', (ns) => ns.map((n) => n.getAttribute('data-pid')));
    const shownColumns = () => page.$$eval('.pcol[data-pid]', (ns) => ns.map((n) => n.getAttribute('data-pid')));
    await page.locator('[data-act="filter-menu"]').click();
    const legend = await page.$$eval('.prow[data-pid]', (ns) => ns.map((n) => n.getAttribute('data-pid')));
    assert.deepEqual(legend, columns, 'the participant list follows the column order');
    const [first, ...others] = columns;
    await page.locator(`[data-act="part"][data-pid="${first}"]`).click();
    assert.ok(!(await shownColumns()).includes(first), 'the hidden column is gone');
    assert.equal(await page.locator(`[data-act="part"][data-pid="${first}"]`).getAttribute('aria-pressed'), 'false');
    assert.ok((await body()).includes(`${columns.length - 1} of ${columns.length} participants`));
    assert.equal(await page.locator(`[data-act="unhide"][data-pid="${first}"]`).count(), 1, 'a pill names it in the toolbar');
    for (const pid of others) await page.locator(`[data-act="part"][data-pid="${pid}"]`).click();
    assert.equal((await shownColumns()).length, 1, 'one click never hides the last participant');
    await page.locator('[data-act="toggle-all"]').click();
    assert.equal((await shownColumns()).length, columns.length, 'select all');
    await page.keyboard.press('Escape');
    await page.locator('[data-role="filter-menu"]').waitFor({ state: 'detached' });

    // labels: a GENERAL row opens a detail and says so, a query row is a checkbox
    assert.ok((await page.locator('[data-act="header"] svg.go').count()) > 0, 'GENERAL rows carry the opens mark');
    assert.equal(await page.locator('[data-act="row"] svg.go').count(), 0, 'query rows carry a checkbox instead');

    // the graph draws what the table ticks; with nothing picked yet, the first row
    // Rows are keyed by query id in the by-recall-bar reading and by group key
    // in the by-group one, so take the ids the page actually rendered rather
    // than assuming which reading is on.
    const rowIds = await page.$$eval('[data-act="row"]', (ns) => ns.map((n) => n.getAttribute('data-id')));
    assert.ok(rowIds.length >= 2, 'the table drew query rows');
    const [firstRow, secondRow] = rowIds;
    const ticked = () => page.$$eval('[data-act="row"][aria-checked="true"]', (ns) => ns.map((n) => n.getAttribute('data-id')));
    assert.deepEqual(await ticked(), [firstRow], 'the first row is ticked to start with');
    // The SVG mounts once the container has been measured, a render later.
    await graph.locator('svg.curve-graph').waitFor();
    assert.ok((await graph.locator('svg.curve-graph polyline').count()) >= 1, 'at least one curve');
    assert.ok((await graph.locator('svg.curve-graph circle').count()) >= 2, 'measured points');
    assert.equal(await graph.locator('input, [role="checkbox"]').count(), 0, 'no row list inside the graph: the table is the list');
    // the plot is 80% of the screen wide, scrolls under a pinned y axis, and opens at recall 1
    const plot = await graph.locator('.graphscroll').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, left: el.scrollLeft }));
    assert.ok(Math.abs(plot.sw + (await graph.locator('svg.curve-yaxis').evaluate((el) => el.getBoundingClientRect().width)) - 1440 * 0.8) < 2, 'the graph is 80% of the screen');
    assert.ok(plot.sw > plot.cw, 'wider than its pane');
    assert.ok(plot.sw - plot.cw - plot.left <= 1, 'and opens at recall 1');
    // a group's label is its title and its reading; the key says the same and is not printed
    assert.ok(!(await page.locator(`[data-act="row"][data-id="${firstRow}"]`).innerText()).includes(firstRow), 'no group key in the label');
    // every row is named by what it asks, k then the case, in one block per case under a firmer rule
    const titles = await page.$$eval('[data-act="row"]', (ns) =>
      ns.map((n) => {
        const label = n.cloneNode(true);
        label.querySelectorAll('.tg').forEach((tail) => tail.remove());
        return label.textContent.trim();
      }),
    );
    assert.ok(titles.every((title) => /^k=\d+( · \S+)?$/.test(title)), 'a label is k, then the filter case');
    const blocks = titles.map((title) => title.split(' · ')[1] ?? 'none').filter((c, i, all) => c !== all[i - 1]);
    assert.ok(blocks.length >= 1);
    assert.equal(new Set(blocks).size, blocks.length, "a case's rows sit together");
    assert.equal(await page.locator('.trow.lead').count(), blocks.length, 'a rule above each block');
    // the bar a group is read at is the graph's line, not the label's; a cell's recall reads `@`
    const tails = await page.$$eval('[data-act="row"] .tg', (ns) => ns.map((n) => n.textContent));
    assert.ok(tails.every((tail) => !tail.includes('@')), 'no recall bar in a group label');
    assert.ok((await page.locator('.cell.gcell .greach').first().innerText()).startsWith('@ '), 'a cell prints @ and the recall reached');
    await page.locator(`[data-act="row"][data-id="${secondRow}"]`).click();
    assert.deepEqual(await ticked(), [firstRow, secondRow], 'a click ticks one more');
    assert.ok((await graph.locator('.panehead').innerText()).includes('2 rows'));
    assert.ok(page.url().includes('?s='));

    // the keyboard: arrows walk the labels, Space ticks the one with focus
    await page.locator(`[data-act="row"][data-id="${firstRow}"]`).focus();
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-act')), 'sort', 'ArrowUp reaches the coverage row');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-id')), firstRow);
    await page.keyboard.press('Space');
    assert.deepEqual(await ticked(), [secondRow], 'Space unticks it');

    // a double-click draws one row alone; clear leaves the graph saying how to start
    await page.locator(`[data-act="row"][data-id="${firstRow}"]`).dblclick();
    assert.deepEqual(await ticked(), [firstRow], 'a double-click draws one row alone');
    await graph.locator('[data-act="plot-clear"]').click();
    assert.deepEqual(await ticked(), []);
    await graph.locator('[data-role="graph-empty"]').waitFor();
    await page.locator(`[data-act="row"][data-id="${firstRow}"]`).click();
    await graph.locator('svg.curve-graph').waitFor();

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

    // a GENERAL header click opens the load-phases detail; Escape closes it, the graph stays
    await page.locator('[data-act="header"][data-key="load"]').click();
    const hd = page.locator('[data-role="header-detail"]');
    await hd.waitFor();
    assert.ok((await hd.innerText()).includes('other'));
    await page.keyboard.press('Escape');
    await hd.waitFor({ state: 'detached' });
    assert.equal(await graph.locator('svg.curve-graph').count(), 1, 'Escape leaves the graph alone');

    // the toolbar: the latency view shows its statistic, where somebody measured latency; the rest is in Display
    assert.equal(await page.locator('[data-act="metric"]').count(), 0, 'Throughput reads QPS and offers no statistic');
    const latencyButton = page.locator('[data-act="view"][data-v="latency"]');
    if (hasLatency) {
      await latencyButton.click();
      await page.locator('[data-act="metric"][data-v="p99"]').click();
      assert.equal(await page.locator('[data-act="metric"][data-v="p99"]').getAttribute('class'), 'on');
    } else {
      assert.ok(await latencyButton.isDisabled(), 'no latency measured: the Latency view is off');
    }
    await page.locator('[data-act="display-menu"]').click();
    await page.locator('[data-act="cells"][data-v="absolute"]').click();
    // the bar reading keeps what was ticked: the group stands for its bars
    await page.locator('[data-act="row-mode"][data-v="bars"]').click();
    await page.keyboard.press('Escape');
    const barTicks = await ticked();
    assert.ok(barTicks.length >= 1 && !barTicks.includes(firstRow), 'the group became its bars');
    assert.ok((await graph.locator('.panehead').innerText()).includes(`${barTicks.length} row`));
    await page.locator(`[data-act="sort"][data-section="${hasFiltered ? 'filtered' : 'nofilter'}"]`).first().click();

    // chips narrow the rows; a pill names the chip while the menu is closed and removes it
    const k100 = () => page.$$eval('[data-act="row"]', (ns) => ns.filter((n) => /k=100\b/.test(n.innerText)).length);
    assert.ok((await k100()) > 0);
    await page.locator('[data-act="filter-menu"]').click();
    await page.locator('[data-act="chip"][data-tag="k:10"]').click();
    await page.keyboard.press('Escape');
    assert.equal(await k100(), 0, 'k=100 rows hidden');
    await page.locator('[data-act="unchip"][data-tag="k:10"]').click();
    assert.equal(await page.locator('[data-act="unchip"]').count(), 0);

    // another dataset from the toolbar: the pick closes the menu and the table follows
    if (datasets.length > 1) {
      await page.locator('[data-act="dataset-menu"]').click();
      const current = await page.locator('[data-act="dataset"][aria-pressed="true"]').getAttribute('data-name');
      const other = datasets.find((d) => d !== current);
      await page.locator(`[data-act="dataset"][data-name="${other}"]`).click();
      await page.locator('[data-role="dataset-menu"]').waitFor({ state: 'detached' });
      assert.ok((await page.locator('[data-act="dataset-menu"]').innerText()).includes(other), 'the toolbar names it');
      assert.ok((await page.locator('[data-role="status"]').innerText()).includes(other), `the status bar describes ${other}`);
    }

    // a hidden participant and the ticked rows are part of the link
    await page.locator('[data-act="filter-menu"]').click();
    await page.locator(`[data-act="part"][data-pid="${first}"]`).click();
    await page.keyboard.press('Escape');
    assert.ok(!(await shownColumns()).includes(first));
    const rowsNow = await page.$$eval('[data-act="row"]', (ns) => ns.map((n) => n.getAttribute('data-id')));
    await page.locator(`[data-act="row"][data-id="${rowsNow[1]}"]`).click();
    const tickedBefore = await ticked();
    assert.equal(tickedBefore.length, 2);

    // theme: the platform toggle flips the html class
    await page.locator('[data-act="theme"][data-v="dark"]').click();
    assert.ok(await page.locator('html').evaluate((el) => el.classList.contains('dark')));

    // the state survives a reload through the URL
    await page.reload();
    await page.locator('.vb-app').waitFor();
    assert.deepEqual(await ticked(), tickedBefore, 'still ticked');
    assert.equal(await page.locator(`[data-act="unhide"][data-pid="${first}"]`).count(), 1, 'still hidden');
    assert.equal(await page.locator(`[data-act="view"][data-v="${hasLatency ? 'latency' : 'throughput'}"]`).getAttribute('class'), 'on');
    await page.locator('[data-act="display-menu"]').click();
    assert.equal(await page.locator('[data-act="cells"][data-v="absolute"]').getAttribute('class'), 'on');
    assert.equal(await page.locator('[data-act="row-mode"][data-v="bars"]').getAttribute('class'), 'on', 'still the bar reading');
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('html').evaluate((el) => el.classList.contains('dark')));

    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    await context.close();
  } finally {
    await browser.close();
  }
});
