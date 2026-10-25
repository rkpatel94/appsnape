/**
 * runner.js — orchestrates a capture run.
 *
 * Flow: launch -> guard the network -> shoot the login screen -> authenticate
 * -> resolve the route map (explicit profile routes, or discovered from the
 * app's own nav) -> for each route: navigate, stabilise, capture the landing
 * state, inspect the DOM, then run the interaction recipes -> write
 * PageInventory.md + gallery + manifest.
 *
 * A route that fails is recorded and the run continues; one broken screen must
 * never cost you the other eighty.
 *
 * Output layout follows the manual convention this tool replaces:
 *   <outputDir>/<runId>/NN_Module/NN_Screen/NN_Label[_Top|_Middle|_Bottom].png
 * The file counter increments per image, so a three-slice form reads
 * 02_Add_Form_Top, 03_Add_Form_Middle, 04_Add_Form_Bottom.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { log, C } = require('./logger');
const { authenticate } = require('./auth');
const { waitForStable } = require('./stabilize');
const { captureScreen } = require('./capture');
const { inspectPage } = require('./inspect');
const { runRecipes, runSetup } = require('./interactions');
 const { autoFillFilters } = require('./autofill');
const { discoverRoutes, slugify, titleFromPath } = require('./discover');
const { writeReports } = require('./report');

const TOOL_VERSION = require('../package.json').version;

function pad2(n) { return String(n).padStart(2, '0'); }

function makeRunId(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`;
}

/** Block mutating verbs at the network layer — the belt to safeClick's braces. */
async function installNetworkGuard(context, cfg, stats) {
  const methods = (cfg.safety.blockMethods || []).map((m) => m.toUpperCase());
  if (!cfg.safety.readOnly || !methods.length) return;
  const allow = (cfg.safety.allowUrlPatterns || []).map((p) => new RegExp(p, 'i'));

  await context.route('**/*', (route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    if (methods.includes(method) && !allow.some((r) => r.test(req.url()))) {
      stats.blockedRequests.push(`${method} ${req.url()}`);
      return route.abort();
    }
    return route.continue();
  });
  log.step(`Network guard active: ${methods.join(', ')} blocked`);
}

function groupRoutes(routes) {
  const order = [];
  const byModule = new Map();
  for (const r of routes) {
    const mod = r.module || 'General';
    if (!byModule.has(mod)) { byModule.set(mod, []); order.push(mod); }
    byModule.get(mod).push(r);
  }
  return order.map((name) => ({ name, routes: byModule.get(name) }));
}

/**
 * Name the landing shot after what the screen actually is, matching the
 * manual convention (list pages are "Grid", not "Landing").
 */
async function landingLabelFor(page, route) {
  if (route.landingLabel) return route.landingLabel;

  // The URL is a far better signal than the DOM: an Add form contains grids
  // (Referenced Records, Change Related To), so DOM sniffing alone labelled
  // the change-initiation form "Grid".
  const p = (route.path || '').toLowerCase();
  if (/\/add(\/|$)/.test(p)) return 'Add_Form';
  if (/\/edit(\/|$)/.test(p)) return 'Edit_Form';
  if (/\/view(\/|$)/.test(p)) return 'View';

  const rows = await page.locator('tbody tr').count().catch(() => 0);
  if (rows > 0) return 'Grid';
  const inputs = await page.locator('input:visible, textarea:visible').count().catch(() => 0);
  if (inputs > 4) return 'Form';
  return 'Page';
}

/**
 * Shoot the login screen before authenticating.
 *
 * Every manual starts by telling the reader how to get in, so this screen is
 * needed for all of them. It has to happen before authenticate(): the 'api'
 * strategy injects the session through an init script, after which the app
 * redirects past the form and it can never be photographed again.
 *
 * It lands in 00_Login so the rest of the modules keep the numbers they had on
 * earlier runs — descriptions.json is keyed by image path, and renumbering
 * every folder would orphan every description already written.
 */
async function captureLoginScreen(context, cfg, stats) {
  const loginPath = (cfg.auth.form && cfg.auth.form.loginPath) || '/';
  const url = cfg.baseUrl + loginPath;
  const baseDir = path.join(cfg.runDir, '00_Login', '01_Login_Page');
  const ext = cfg.capture.type === 'jpeg' ? 'jpg' : 'png';

  const record = {
    path: loginPath, name: 'Login Page', url,
    captures: [], meta: null, status: 'ok', error: null,
  };

  const page = await context.newPage();
  page.setDefaultTimeout(cfg.interactions.perActionTimeout);
  log.group('Login screen');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.auth.verify.timeout || 30000 });
    await waitForStable(page, cfg);

    const fields = await page.locator('input[type="password"]').count().catch(() => 0);
    if (!fields) log.warn(`no password field at ${url} — capturing it anyway`);

    let fileIndex = 0;
    const makePath = (suffix) => {
      fileIndex += 1;
      return path.join(baseDir, `${pad2(fileIndex)}_Page${suffix}.${ext}`);
    };
    const res = await captureScreen(page, makePath, cfg);
    record.captures.push({
      label: 'Page', note: 'The sign-in screen as it opens',
      files: res.files, slices: res.slices, contentHeight: res.contentHeight,
      width: res.width, height: res.height,
    });
    stats.captures += res.files.length;
    record.meta = await inspectPage(page);
    log.ok(`Login Page${res.slices > 1 ? ` ${C.dim}(${res.slices} slices)${C.reset}` : ''}`);
  } catch (e) {
    record.status = 'failed';
    record.error = (e && e.message ? e.message : String(e)).split('\n')[0];
    stats.failures += 1;
    log.error(record.error);
  } finally {
    await page.close().catch(() => {});
    log.groupEnd();
  }
  return { name: 'Login', routes: [record] };
}

async function captureRoute(page, cfg, route, moduleIndex, moduleName, routeIndex, stats) {
  const url = cfg.baseUrl + route.path;
  const moduleDir = `${pad2(moduleIndex + 1)}_${slugify(moduleName)}`;
  const routeDir = `${pad2(routeIndex + 1)}_${slugify(route.slug || route.name || titleFromPath(route.path))}`;
  const baseDir = path.join(cfg.runDir, moduleDir, routeDir);
  const ext = cfg.capture.type === 'jpeg' ? 'jpg' : 'png';

  const record = {
    path: route.path, name: route.name || titleFromPath(route.path), url,
    captures: [], meta: null, status: 'ok', error: null,
  };

  let fileIndex = 0;
  const shoot = async (label, opts) => {
    const o = opts || {};
    // The counter advances per IMAGE, so slices of one screen occupy
    // consecutive numbers exactly like the hand-made inventory.
    const makePath = (suffix) => {
      fileIndex += 1;
      return path.join(baseDir, `${pad2(fileIndex)}_${slugify(label)}${suffix}.${ext}`);
    };
    const res = await captureScreen(page, makePath, cfg);
    record.captures.push({
      label, note: o.note || '', files: res.files,
      slices: res.slices, contentHeight: res.contentHeight,
      width: res.width, height: res.height,
    });
    stats.captures += res.files.length;
    const sliceInfo = res.slices > 1 ? ` ${C.dim}(${res.slices} slices, ${res.contentHeight}px)${C.reset}` : '';
    log.ok(`${label}${sliceInfo}`);
    if (o.inspect && !record.meta) record.meta = await inspectPage(page);
  };

  log.group(`${route.name || route.path}  ${C.dim}${route.path}${C.reset}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.auth.verify.timeout || 30000 });
    await waitForStable(page, cfg);

    if (route.waitFor) {
      await page.locator(route.waitFor).first()
        .waitFor({ state: 'visible', timeout: 15000 })
        .catch(() => log.warn(`waitFor "${route.waitFor}" not found`));
    }

    // Put the screen into a state worth documenting before the first shot:
    // explicit per-route steps first, then the generic filter fill for any
    // screen that still opens empty.
    if ((route.setup || []).length) {
      await runSetup(page, { cfg }, route.setup);
    }
    const filled = await autoFillFilters(page, cfg, route).catch((e) => {
      log.warn(`autofill: ${String(e.message || e).split('\n')[0]}`);
      return null;
    });
    if (filled) log.step(`autofill: ${filled}`);

    const label = await landingLabelFor(page, route);
    await shoot(label, { note: route.note || 'Default state on load' });
    record.meta = await inspectPage(page);

    if (cfg.interactions.enabled && route.interactions !== false) {
      await runRecipes(page, { cfg, shoot, recipes: route.recipes });
    }
  } catch (e) {
    record.status = 'failed';
    record.error = (e && e.message ? e.message : String(e)).split('\n')[0];
    stats.failures += 1;
    log.error(record.error);
  } finally {
    log.groupEnd();
  }
  return record;
}

async function run(cfg, opts) {
  const options = opts || {};
  const startedAt = new Date();
  const stats = { routes: 0, captures: 0, failures: 0, blockedRequests: [] };

  const runId = options.runId || (cfg.output.timestampRuns ? makeRunId(startedAt) : 'latest');
  cfg.runId = runId;
  cfg.runDir = path.join(cfg.outputDir, runId);

  log.banner(`AppShot v${TOOL_VERSION} — ${cfg.displayName}`);
  log.info(`${C.dim}${cfg.baseUrl}  ->  ${cfg.runDir}${C.reset}`);

  const browser = await chromium.launch({
    headless: options.headed ? false : cfg.browser.headless,
    slowMo: cfg.browser.slowMo || 0,
  });

  const context = await browser.newContext({
    viewport: cfg.browser.viewport,
    deviceScaleFactor: cfg.browser.deviceScaleFactor,
    locale: cfg.browser.locale,
    timezoneId: cfg.browser.timezoneId || undefined,
    ignoreHTTPSErrors: cfg.browser.ignoreHTTPSErrors,
  });

  // Unsaved-changes prompts must never wedge the run.
  context.on('dialog', (d) => d.accept().catch(() => {}));

  let manifest = null;
  try {
    await installNetworkGuard(context, cfg, stats);

    // --only is a patch of one module and does not want the login screen
    // dropped on top of it; --limit is a short run of everything, so it does.
    let loginModule = null;
    if (cfg.capture.loginScreen && !options.dryRun && !options.only
        && (cfg.auth.strategy || 'form').toLowerCase() !== 'none') {
      fs.mkdirSync(cfg.runDir, { recursive: true });
      loginModule = await captureLoginScreen(context, cfg, stats);
    }

    // A dry run against a profile that already lists its routes is just a
    // preview of the plan, so it must not need the app to be reachable.
    if (options.dryRun && (cfg.routes || []).length) {
      let preview = cfg.routes;
      if (options.only) {
        const re = new RegExp(options.only, 'i');
        preview = preview.filter((r) => re.test(r.path) || re.test(r.name || '') || re.test(r.module || ''));
      }
      if (options.limit) preview = preview.slice(0, Number(options.limit));
      log.banner('Dry run — routes that would be captured:');
      groupRoutes(preview).forEach((m, i) => {
        log.info(`${C.bold}${pad2(i + 1)} ${m.name}${C.reset}`);
        m.routes.forEach((r) => log.info(`   ${(r.name || '').padEnd(34)} ${C.dim}${r.path}${C.reset}`));
      });
      return { dryRun: true, routes: preview };
    }

    await authenticate(context, cfg);

    let routes = cfg.routes || [];
    if (options.discover || !routes.length) {
      if (!cfg.discovery.enabled && !options.discover) {
        throw new Error('No routes in the profile and discovery is disabled. Add "routes" or set discovery.enabled = true.');
      }
      routes = await discoverRoutes(context, cfg);
    }

    // Module/screen folder numbers come from the profile's full order, never
    // from the filtered subset — otherwise `--only` writes 01_* folders that
    // collide with a different module from a full run.
    const canonicalModules = [];
    const canonicalIndexInModule = new Map();
    for (const r of routes) {
      const m = r.module || 'General';
      if (!canonicalModules.includes(m)) canonicalModules.push(m);
      const key = `${m}|${r.path}`;
      const seen = routes.filter((x) => (x.module || 'General') === m).indexOf(r);
      canonicalIndexInModule.set(key, seen);
    }

    if (options.only) {
      const re = new RegExp(options.only, 'i');
      routes = routes.filter((r) => re.test(r.path) || re.test(r.name || '') || re.test(r.module || ''));
      log.info(`Filtered to ${routes.length} route(s) matching /${options.only}/i`);
    }
    if (options.limit) routes = routes.slice(0, Number(options.limit));
    if (!routes.length) throw new Error('No routes to capture after filtering.');

    if (options.dryRun) {
      log.banner('Dry run — routes that would be captured:');
      groupRoutes(routes).forEach((m, i) => {
        log.info(`${C.bold}${pad2(i + 1)} ${m.name}${C.reset}`);
        m.routes.forEach((r) => log.info(`   ${(r.name || '').padEnd(38)} ${C.dim}${r.path}${C.reset}`));
      });
      return { dryRun: true, routes };
    }

    fs.mkdirSync(cfg.runDir, { recursive: true });
    const page = await context.newPage();
    page.setDefaultTimeout(cfg.interactions.perActionTimeout);

    const grouped = groupRoutes(routes);
    const modules = [];
    if (loginModule) modules.push(loginModule);
    for (let mi = 0; mi < grouped.length; mi++) {
      const m = grouped[mi];
      const modIdx = Math.max(0, canonicalModules.indexOf(m.name));
      log.banner(`${pad2(modIdx + 1)} — ${m.name}  (${m.routes.length} screen${m.routes.length === 1 ? '' : 's'})`);
      const records = [];
      for (const route of m.routes) {
        const rIdx = canonicalIndexInModule.get(`${m.name}|${route.path}`);
        stats.routes += 1;
        records.push(await captureRoute(
          page, cfg, route, modIdx, m.name,
          rIdx === undefined ? records.length : rIdx, stats
        ));
        if (options.onProgress) {
          options.onProgress({ done: stats.routes, total: routes.length, route: route.name, captures: stats.captures });
        }
      }
      modules.push({ name: m.name, routes: records });
    }
    // Counted only now: onProgress compares against the profile's route list,
    // which the login screen is not part of.
    if (loginModule) stats.routes += 1;

    const finishedAt = new Date();
    manifest = {
      toolVersion: TOOL_VERSION,
      runId,
      app: {
        name: cfg.name,
        displayName: cfg.displayName,
        baseUrl: cfg.baseUrl,
        user: cfg.credentials.username || null,
        blockedMethods: cfg.safety.blockMethods || [],
        viewport: cfg.browser.viewport,
      },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSec: Math.round((finishedAt - startedAt) / 1000),
      modules,
      stats: {
        routes: stats.routes,
        captures: stats.captures,
        failures: stats.failures,
        blockedRequests: stats.blockedRequests.length,
      },
    };

    const written = writeReports(manifest, cfg.runDir);

    log.banner('Done');
    log.ok(`${stats.captures} screenshot(s) across ${stats.routes} screen(s) in ${manifest.durationSec}s`);
    log.info(`${C.dim}All images ${cfg.browser.viewport.width}x${cfg.browser.viewport.height}${C.reset}`);
    if (stats.failures) log.warn(`${stats.failures} route(s) failed — see PageInventory.md`);
    if (stats.blockedRequests.length) {
      log.info(`${C.dim}${stats.blockedRequests.length} mutating request(s) blocked by the read-only guard${C.reset}`);
    }
    log.info(`${C.bold}Inventory:${C.reset} ${written.mdPath}`);
    log.info(`${C.bold}Gallery:  ${C.reset} ${written.htmlPath}`);
    return manifest;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { run, TOOL_VERSION };
