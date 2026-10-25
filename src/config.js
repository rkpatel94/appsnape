/**
 * config.js — loads an application profile, merges it over DEFAULTS, and
 * resolves ${ENV_VAR} placeholders.
 *
 * Design rule: an app profile describes WHAT to capture and HOW the app is
 * shaped. It never contains secrets — credentials are always ${ENV} references
 * resolved from .env / the shell, so profiles are safe to commit.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const DEFAULTS = {
  name: 'app',
  displayName: null,
  baseUrl: null,
  outputDir: null,               // defaults to <root>/output/<name>
  credentials: { username: null, password: null },

  auth: {
    strategy: 'form',            // 'none' | 'api' | 'form'
    api: {
      endpoint: null,
      method: 'POST',
      headers: {},
      body: {},
      sessionStorage: {},        // { storageKey: 'dot.path' | 'dot.path::json' }
      localStorage: {},
      cookies: [],               // [{ name, path: 'dot.path', domain, cookiePath }]
    },
    form: {
      loginPath: '/',
      usernameSelector: 'input[name="username"], input[type="text"]',
      passwordSelector: 'input[type="password"]',
      submitSelector: 'button[type="submit"]',
      extraSteps: [],            // [{ action: 'click'|'fill'|'wait', selector, value }]
    },
    verify: { path: '/dashboard', selector: null, timeout: 30000 },
  },

  browser: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: null,
    ignoreHTTPSErrors: true,
    slowMo: 0,
  },

  capture: {
    // Every image is exactly viewport-sized; taller screens become an ordered
    // series of overlapping slices (_Top / _Middle / _Bottom).
    // Every manual opens with "how to log in", so the login screen is shot
    // before the session is injected — otherwise the app bounces straight to
    // the dashboard and the screen is never seen.
    loginScreen: true,
    freezeAnimations: true,
    hideScrollbars: true,
    preScroll: true,              // walk the screen once to trigger lazy content
    preScrollStepRatio: 0.85,
    preScrollWaitMs: 250,
    settleMs: 700,
    chartSettleMs: 1200,          // extra wait when <canvas> charts are present
    sliceOverlap: 80,             // px of overlap between consecutive slices
    sliceSettleMs: 350,
    minSliceGain: 140,          // overflow below this is not worth a 2nd image
    maxSlices: 12,                // guard against runaway pages
    type: 'png',
    maskSelectors: [],            // e.g. clocks / session timers
  },

  stabilize: {
    networkIdleTimeout: 12000,
    spinnerSelectors: [
      '.MuiCircularProgress-root',
      '[role="progressbar"]',
      '[aria-busy="true"]',
      '.spinner', '.loader',
      '[class*="Spinner"]',
    ],
    spinnerTimeout: 15000,
    waitFonts: true,
  },

  discovery: {
    enabled: false,
    navSelectors: ['aside', 'nav', '[role="navigation"]', '.sidebar'],
    expandSelectors: ['[aria-expanded="false"]'],
    expandPasses: 3,
    includePatterns: ['^/'],
    excludePatterns: ['logout', 'signout', '^/$'],
    maxRoutes: 200,
  },

  // Filtered screens open empty (date range defaulted to today, a required
  // person unset). This fills the filter in and presses the screen's own apply
  // control so what gets captured actually contains data.
  autoFilter: {
    enabled: true,
    rangeDays: 365,
    preferredUser: null,          // e.g. "Divy Bhadania" — matched on the label shown
    applyButtons: '^(view|apply|apply filter|search|show|go|submit search)$',
    // Never touch data-entry forms.
    skipPathPattern: '/(add|edit|create|new)(/|$)',
    maxFields: 12,
  },

  interactions: {
    enabled: true,
    // 'paginate' is off by default: a second page of the same table rarely
    // teaches the reader anything and doubles the page count of a manual.
    recipes: ['accordions', 'toggleSweep', 'dropdownSweep', 'tabs', 'filters', 'openAdd', 'rowView', 'rowEdit'],
    // Monitoring screens only: opt in per route, they are slow and specific.
    // 'hoverSweep'  trend graphs and device info revealed by the pointer
    // 'iconBar'     the unlabelled icon strip (map / alarms / sound)
    addButtonText: '^(\\+\\s*)?(add|new|create)\\b',
    filterButtonText: '^(filter|filters|advanced search)$',
    viewRowTitle: '(view|detail|eye)',
    editRowTitle: '(edit|modify|pencil)',
    // Used only by 'rowDeactivate', which is not in the default recipe list
    // above: it opens the confirmation window and closes it again without
    // confirming, and every non-GET is aborted while it is open. An app profile
    // has to name the recipe for any of this to run.
    deactivateRowTitle: '(deactivate|inactivate|delete|remove|trash)',
    // Grids disable an action on rows whose status does not allow it, so the
    // row recipes look past row 1 for one where it is live.
    maxRowScan: 10,
    maxTabs: 8,
    maxSweep: 15,
    maxHover: 6,                // representative hover examples per screen
    hoverSettleMs: 2200,        // trend graphs draw after a short delay
    iconSettleMs: 5000,
    maxViewPanels: 6,           // controls explored inside a view a toolbar icon opened
    printTimeoutMs: 30000,
    maxAddMenuItems: 4,         // choices opened when one Add button offers several forms
    maxPanelActions: 4,         // distinct actions pressed inside an opened panel      // a printed report can take a while to render         // a 3D facility plan takes a while to render               // cap on options swept per selector/toggle group
    perActionTimeout: 8000,
  },

  safety: {
    readOnly: true,
    // Hard block: safeClick() refuses any control whose accessible text matches.
    denyClickText: '^(save|submit|delete|remove|deactivate|reject|approve|confirm|yes|send|sign|update|discard)\\b',
    // Network guard. POST is allowed because many enterprise APIs use POST for
    // list/search reads; PUT/PATCH/DELETE are almost always mutations.
    blockMethods: ['PUT', 'PATCH', 'DELETE'],
    allowUrlPatterns: [],        // regex strings exempt from blockMethods
  },

  output: {
    // Each run lands in its own <outputDir>/<YYYY-MM-DD_HHMM>/ folder so runs
    // can be compared over time. Set false to always overwrite "latest".
    timestampRuns: true,
  },

  routes: [],                    // explicit route list (see README)
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(base && base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

/** Replace ${VAR} anywhere in the config tree from process.env. */
function resolveEnv(node, missing) {
  if (typeof node === 'string') {
    return node.replace(/\$\{([A-Za-z0-9_]+)\}/g, (full, key) => {
      if (process.env[key] === undefined) { missing.push(key); return full; }
      return process.env[key];
    });
  }
  if (Array.isArray(node)) return node.map((n) => resolveEnv(n, missing));
  if (isPlainObject(node)) {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = resolveEnv(v, missing);
    return out;
  }
  return node;
}

function listProfiles() {
  const dir = path.join(ROOT, 'apps');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

function resolveProfilePath(appNameOrPath) {
  const direct = path.resolve(appNameOrPath);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const inApps = path.join(ROOT, 'apps', `${appNameOrPath}.json`);
  if (fs.existsSync(inApps)) return inApps;
  throw new Error(
    `App profile not found: "${appNameOrPath}".\n` +
    `Looked for:\n  ${direct}\n  ${inApps}\n` +
    `Available profiles: ${listProfiles().join(', ') || '(none - run: appshot init <name> --url <url>)'}`
  );
}

function loadConfig(appNameOrPath, overrides) {
  const file = resolveProfilePath(appNameOrPath);
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));

  const missing = [];
  const merged = deepMerge(deepMerge(DEFAULTS, raw), overrides || {});
  const cfg = resolveEnv(merged, missing);

  if (missing.length) {
    const uniq = [...new Set(missing)];
    throw new Error(
      `Missing environment variable(s): ${uniq.join(', ')}\n` +
      `Set them in ${path.join(ROOT, '.env')} (copy .env.example) or export them in your shell.`
    );
  }
  if (!cfg.baseUrl) throw new Error(`"baseUrl" is required in ${file}`);

  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  cfg.displayName = cfg.displayName || cfg.name;
  cfg.outputDir = cfg.outputDir
    ? path.resolve(cfg.outputDir)
    : path.join(ROOT, 'output', cfg.name);
  cfg.__profilePath = file;
  return cfg;
}

/**
 * Build a config from a plain object instead of a profile file — used by the
 * UI, where the URL and credentials are typed in rather than stored on disk.
 * Credentials passed this way are never written anywhere.
 */
function makeConfig(raw, overrides) {
  const missing = [];
  const merged = deepMerge(deepMerge(DEFAULTS, raw || {}), overrides || {});
  const cfg = resolveEnv(merged, missing);
  if (!cfg.baseUrl) throw new Error('"baseUrl" is required');

  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  cfg.name = cfg.name || 'app';
  cfg.displayName = cfg.displayName || cfg.name;
  cfg.outputDir = cfg.outputDir
    ? path.resolve(cfg.outputDir)
    : path.join(ROOT, 'output', cfg.name);
  return cfg;
}

module.exports = { loadConfig, makeConfig, listProfiles, DEFAULTS, deepMerge, ROOT };
