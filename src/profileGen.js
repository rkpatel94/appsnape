/**
 * profileGen.js — build an application profile from nothing but a URL and
 * credentials.
 *
 * Every application here is the same shape: a React admin shell, a JSON login
 * at /api/authentication/login that returns a token plus a userMaster object,
 * a sidebar, a report screen whose sub-reports live behind a selector, and a
 * standard set of account/support pages. That regularity is what makes this
 * possible — the generator assumes the house stack and then verifies every
 * assumption against the live app rather than trusting it.
 *
 * What it does:
 *   1. Logs in and confirms the session works.
 *   2. Walks the sidebar for routes, keeping the menu hierarchy as modules.
 *   3. Opens the report screen and enumerates its report types, which the
 *      sidebar never links.
 *   4. Probes the standard account/support screens.
 *   5. Loads every candidate route and DROPS the ones that 404, so a broken
 *      screen never reaches the capture run or the manual.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { log, C } = require('./logger');
const { makeConfig, ROOT } = require('./config');
const { authenticate } = require('./auth');
const { discoverRoutes, slugify, titleFromPath } = require('./discover');
const { waitForStable } = require('./stabilize');

/** The house standard — identical across CCMS, CAPA and the rest. */
function standardProfile(name, baseUrl) {
  const U = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return {
    name,
    displayName: name.toUpperCase(),
    baseUrl: `\${${U}_BASE_URL}`,
    credentials: { username: `\${${U}_USER}`, password: `\${${U}_PASSWORD}` },
    auth: {
      strategy: 'api',
      api: {
        endpoint: '/api/authentication/login',
        method: 'POST',
        body: {
          username: '{{username}}', password: '{{password}}',
          ipAddress: '127.0.0.1', latitude: '0', longitude: '0',
        },
        sessionStorage: {
          authToken: 'token',
          userId: 'userMaster.userID',
          plantId: 'userMaster.plantID',
          userData: 'userMaster::json',
        },
      },
      verify: { path: '/dashboard' },
    },
    browser: { headless: true, viewport: { width: 1440, height: 900 } },
    capture: { settleMs: 900 },
    autoFilter: { enabled: true, rangeDays: 365, preferredUser: 'Divy Bhadania' },
    discovery: {
      enabled: true,
      navSelectors: ['aside', 'nav', '[role="navigation"]'],
      excludePatterns: ['logout', 'signout', '^/$', 'forgot-password'],
    },
    safety: {
      readOnly: true,
      blockMethods: ['PUT', 'PATCH', 'DELETE'],
      allowUrlPatterns: ['/api/authentication/login'],
    },
    routes: [],
  };
}

const STANDARD_EXTRAS = [
  { module: 'Account', name: 'User Profile', path: '/profile', recipes: ['tabs'] },
  { module: 'Account', name: 'Change Password', path: '/change-password', recipes: [] },
  { module: 'Support', name: 'Help Line', path: '/help-line', recipes: [] },
  { module: 'Support', name: 'User Manual', path: '/user-manual', recipes: [] },
  { module: 'Support', name: 'Release Notes', path: '/release-notes', recipes: [] },
  { module: 'Support', name: 'About System', path: '/about-system', recipes: [] },
];

const REPORT_ENTRY_PATHS = [
  '/report-dashboard/audit-trail-report',
  '/report-dashboard/audit-report',
  '/reports/audit-trail-report',
];

async function isMissing(page) {
  return page.evaluate(() => {
    const t = (document.body.innerText || '').slice(0, 1500);
    return /page not found|404|not found|unauthorized|no permission/i.test(t);
  }).catch(() => false);
}

/** Enumerate the report types hidden behind the report screen's selector. */
async function discoverReports(page, cfg) {
  let entry = null;
  for (const p of REPORT_ENTRY_PATHS) {
    await page.goto(cfg.baseUrl + p, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1600);
    if (!(await isMissing(page))) { entry = p; break; }
  }
  if (!entry) return [];

  const selector = page.locator('[role="combobox"]').first();
  if (!(await selector.isVisible().catch(() => false))) return [];

  await selector.click().catch(() => {});
  await page.waitForTimeout(800);
  const names = await page.locator('[role="option"]').allInnerTexts().catch(() => []);
  await page.keyboard.press('Escape').catch(() => {});
  if (!names.length) return [];

  const out = [];
  for (const raw of names) {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const sel = page.locator('[role="combobox"]').first();
    await sel.click().catch(() => {});
    await page.waitForTimeout(500);
    const opt = page.locator('[role="option"]').filter({ hasText: name }).first();
    if (!(await opt.isVisible().catch(() => false))) { await page.keyboard.press('Escape').catch(() => {}); continue; }
    await opt.click().catch(() => {});
    await page.waitForTimeout(1400);
    const p = new URL(page.url()).pathname;
    if (!out.some((r) => r.path === p)) {
      out.push({
        module: 'Reports',
        name,
        slug: slugify(name),
        path: p,
        // Each report is already its own route here, so the view-selector must
        // NOT be swept as well — that would capture all of them from each one.
        // Reports have no rows to open and nothing to add, either.
        recipes: ['accordions', 'tabs', 'filters'],
      });
    }
  }
  return out;
}

/** Load each route and drop the ones that do not exist. */
async function validateRoutes(page, cfg, routes) {
  const kept = [];
  const dropped = [];
  for (const r of routes) {
    await page.goto(cfg.baseUrl + r.path, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(900);
    if (await isMissing(page)) dropped.push(r);
    else kept.push(r);
  }
  return { kept, dropped };
}

/** Persist credentials so the same app can be re-run without retyping them. */
function saveCredentials(name, baseUrl, username, password) {
  const U = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const envPath = path.join(ROOT, '.env');
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';

  const upsert = (key, value) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, `${key}=${value}`);
    else text += `${text.endsWith('\n') || !text ? '' : '\n'}${key}=${value}\n`;
  };
  upsert(`${U}_BASE_URL`, baseUrl);
  upsert(`${U}_USER`, username);
  upsert(`${U}_PASSWORD`, password);
  // Remembered so the next app only needs a URL.
  upsert('DEFAULT_USER', username);
  upsert('DEFAULT_PASSWORD', password);

  fs.writeFileSync(envPath, text, 'utf-8');
  return envPath;
}

/**
 * Build and save a profile. Returns { profilePath, routes, dropped, envPath }.
 */
async function generateProfile({ name, baseUrl, username, password, headless = true }) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (!slug) throw new Error('A short name is required (used for the profile and output folder).');
  if (!baseUrl) throw new Error('The application URL is required.');
  if (!username || !password) throw new Error('Username and password are required.');

  const draft = standardProfile(slug, baseUrl);
  // Resolve against the values actually supplied rather than the environment,
  // so generation works before anything is written to .env.
  const cfg = makeConfig(Object.assign({}, draft, {
    baseUrl,
    credentials: { username, password },
  }));

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: cfg.browser.viewport,
    ignoreHTTPSErrors: true,
  });

  try {
    log.group(`Building a profile for ${slug}`);
    await authenticate(context, cfg);

    const page = await context.newPage();
    const navRoutes = await discoverRoutes(context, cfg);
    log.step(`${navRoutes.length} screen(s) from the sidebar`);

    const reportRoutes = await discoverReports(page, cfg);
    log.step(`${reportRoutes.length} report type(s) behind the report selector`);

    // Anything the sidebar already covers should not be duplicated.
    const seen = new Set(navRoutes.map((r) => r.path));
    const extras = STANDARD_EXTRAS.filter((r) => !seen.has(r.path))
      .map((r) => Object.assign({ slug: slugify(r.name) }, r));
    const reports = reportRoutes.filter((r) => !seen.has(r.path));

    // A dashboard is always worth capturing even if the menu links it oddly.
    const all = [...navRoutes, ...reports, ...extras];

    log.step(`checking ${all.length} screen(s) actually load…`);
    const { kept, dropped } = await validateRoutes(page, cfg, all);
    if (dropped.length) {
      log.warn(`${dropped.length} screen(s) do not open and were left out:`);
      dropped.forEach((d) => log.info(`    ${d.name}  ${C.dim}${d.path}${C.reset}`));
    }

    kept.forEach((r) => {
      r.slug = r.slug || slugify(r.name || titleFromPath(r.path));
      r.module = r.module || 'General';
    });

    const profile = standardProfile(slug, baseUrl);
    profile.displayName = name.length > 6 ? name : name.toUpperCase();
    profile.routes = kept.map((r) => {
      const out = { module: r.module, name: r.name, slug: r.slug, path: r.path };
      if (r.recipes) out.recipes = r.recipes;
      return out;
    });

    const profilePath = path.join(ROOT, 'apps', `${slug}.json`);
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n', 'utf-8');
    const envPath = saveCredentials(slug, baseUrl, username, password);

    log.ok(`${profile.routes.length} screen(s) saved to ${profilePath}`);
    return { profilePath, envPath, routes: profile.routes, dropped, name: slug };
  } finally {
    log.groupEnd();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { generateProfile, standardProfile, saveCredentials };
