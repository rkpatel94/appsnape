/**
 * Prove rowDeactivate offline, against a page that behaves like the real grid:
 * a disabled Delete on row 1, a live one on row 2, and a confirm window that
 * only writes when Confirm & Sign is pressed.
 *
 * What has to hold:
 *   1. it skips the disabled control and finds the live one
 *   2. the confirmation window is captured
 *   3. Cancel is what closes it — Confirm is never pressed
 *   4. no password is typed
 *   5. nothing but a GET leaves the browser while the window is open
 */
const path = require('path');
const { chromium } = require('playwright');
// makeConfig, not loadConfig: the test must run on a fresh checkout with no
// .env and no application set up, so it builds a config from the defaults
// rather than reading a profile.
const { makeConfig } = require('../src/config.js');
const { recipes } = require('../src/interactions.js');

const PAGE = 'file:///' + path.join(__dirname, 'fixtures', 'fake-grid.html').replace(/\\/g, '/');

(async () => {
  const cfg = makeConfig({ name: 'test', baseUrl: 'http://localhost' });
  const browser = await chromium.launch({ headless: true });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // the run-level guard, exactly as the runner installs it
  const leaked = [];
  await ctxB.route('**/*', (route) => {
    const m = route.request().method().toUpperCase();
    if (['PUT', 'PATCH', 'DELETE'].includes(m)) return route.abort();
    if (m !== 'GET') leaked.push(`${m} ${route.request().url()}`);
    return route.continue();
  });

  const page = await ctxB.newPage();
  // The recipe reloads the screen when it is done, so what the page did has to
  // be collected out here as it happens rather than read back afterwards.
  const events = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('AUDIT ')) events.push(t.slice(6));
  });
  let modalWasClosed = false;
  page.on('framenavigated', async () => {
    // record the state reached just before the reload wiped it
    modalWasClosed = modalWasClosed || events.includes('cancelled');
  });
  await page.goto(PAGE);

  const shots = [];
  const ctx = {
    cfg,
    shoot: async (label, opts) => { shots.push({ label, note: opts && opts.note }); },
  };

  await recipes.rowDeactivate(page, ctx);

  const opens = events.filter((e) => e.startsWith('confirm opened')).length;
  const pw = await page.evaluate(() => (document.getElementById('pw') || {}).value || '');
  const modalOpen = await page.evaluate(
    () => document.getElementById('modal').classList.contains('on'));

  const checks = [
    ['found the live control, skipped the disabled one', opens === 1],
    ['it was row 2 that was used', events.includes('confirm opened for Author')],
    ['captured the confirmation window', shots.some((s) => s.label === 'Deactivate_Confirm')],
    ['closed it with Cancel', events.filter((e) => e === 'cancelled').length === 1],
    ['never pressed Confirm & Sign', !events.some((e) => e.startsWith('CONFIRMED'))],
    ['never typed a password', pw === ''],
    ['nothing was written', leaked.length === 0],
    ['left the window closed', modalOpen === false],
  ];
  let ok = true;
  for (const [what, pass] of checks) {
    console.log(`${pass ? ' ok ' : 'FAIL'}  ${what}`);
    ok = ok && pass;
  }
  console.log('\ncaptures:', shots.map((s) => s.label).join(', ') || '(none)');
  if (leaked.length) console.log('leaked:', leaked);

  // ---- the worst case: a Delete that writes on the spot, no confirmation ----
  console.log('\n-- a screen that deletes without asking --');
  const page2 = await ctxB.newPage();
  const ev2 = [];
  page2.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('AUDIT ')) ev2.push(t.slice(6));
  });
  await page2.goto('file:///' + path.join(__dirname, 'fixtures', 'fake-grid-nomodal.html').replace(/\\/g, '/'));
  const shots2 = [];
  await recipes.rowDeactivate(page2, {
    cfg,
    shoot: async (label) => { shots2.push(label); },
  });

  const checks2 = [
    ['the click did reach the delete', ev2.some((e) => e.startsWith('deleting straight away'))],
    ['the write never reached a server', !ev2.some((e) => e.startsWith('SERVER WAS REACHED'))],
    ['the write was blocked at the network layer', ev2.some((e) => e.startsWith('write blocked'))],
    ['nothing was captured, since no window opened', shots2.length === 0],
    ['nothing leaked past the run guard', leaked.length === 0],
  ];
  for (const [what, pass] of checks2) {
    console.log(`${pass ? ' ok ' : 'FAIL'}  ${what}`);
    ok = ok && pass;
  }

  await browser.close();
  console.log(ok ? '\nall checks passed' : '\nSOMETHING FAILED');
  process.exit(ok ? 0 : 1);
})();
