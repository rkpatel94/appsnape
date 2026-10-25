/**
 * ui/server.js — local API + static host for the AppShot UI.
 *
 * Runs on the operator's own machine and talks to the same src/ modules the CLI
 * uses, so the UI and the CLI can never drift apart.
 *
 * On credentials: generating a profile saves the username and password to the
 * local .env file so the same application can be re-run without retyping them,
 * and remembers them as the default for the next application. That file is
 * gitignored and stays on this machine. Passwords are never logged and are
 * never sent back to the browser — /api/defaults reports only whether one is
 * stored. App profiles themselves stay clean: they reference ${ENV} names, so
 * apps/*.json remain safe to commit.
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const { chromium } = require('playwright');

const { makeConfig, loadConfig, listProfiles, ROOT } = require('../src/config');
const { log, stripAnsi } = require('../src/logger');
const { run } = require('../src/runner');
const { authenticate } = require('../src/auth');
const { discoverRoutes } = require('../src/discover');
const { generateProfile, standardProfile } = require('../src/profileGen');
const { generateDescriptions } = require('../src/describe');
const { generateManual } = require('../src/manual');

const app = express();
const PORT = process.env.APPSHOT_UI_PORT || 4477;
const OUTPUT_ROOT = path.join(ROOT, 'output');

app.use(express.json({ limit: '2mb' }));

// Screenshots are served straight from the output tree.
app.use('/shots', express.static(OUTPUT_ROOT));

// ---------------------------------------------------------------- run state

/**
 * One run at a time. The logger sink is process-global, so a second concurrent
 * run would interleave its output into the first run's stream.
 */
const state = {
  running: false,
  id: null,
  lines: [],
  progress: { done: 0, total: 0, captures: 0, route: null },
  result: null,
  error: null,
  clients: [],
};

function push(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  state.clients.forEach((res) => res.write(payload));
}

function addLine(line) {
  const entry = { ...line, message: stripAnsi(line.message), t: Date.now() };
  state.lines.push(entry);
  if (state.lines.length > 2000) state.lines.shift();
  push('log', entry);
}

// ------------------------------------------------------------------ helpers

/**
 * Turn the UI form into a config object.
 *
 * Login is not asked for in the UI: every application here uses the same JSON
 * login endpoint and lands on /dashboard, so that is baked in as the house
 * standard rather than being retyped for each app.
 */
function configFromForm(body) {
  const {
    name, displayName, baseUrl, username, password,
    viewportWidth, viewportHeight, headless, readOnly, recipes, routes,
  } = body;

  const raw = Object.assign(standardProfile(
    (name || 'app').toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
    baseUrl
  ), {
    displayName: displayName || name || 'App',
    baseUrl,
    credentials: { username: username || null, password: password || null },
    browser: {
      headless: headless !== false,
      viewport: {
        width: Number(viewportWidth) || 1440,
        height: Number(viewportHeight) || 900,
      },
    },
    safety: { readOnly: readOnly !== false },
  });

  if (Array.isArray(recipes) && recipes.length) raw.interactions = { recipes };
  if (Array.isArray(routes) && routes.length) raw.routes = routes;
  return raw;
}

/** Stored credentials, so a password typed once need not be typed again. */
function storedCredentials(appName) {
  const U = String(appName || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return {
    username: process.env[`${U}_USER`] || process.env.DEFAULT_USER || null,
    password: process.env[`${U}_PASSWORD`] || process.env.DEFAULT_PASSWORD || null,
    baseUrl: process.env[`${U}_BASE_URL`] || null,
  };
}

/** Fill in anything the operator left blank from what is already stored. */
function applyStoredCredentials(body) {
  const stored = storedCredentials(body.profile || body.name);
  const out = Object.assign({}, body);
  if (!out.username && stored.username) out.username = stored.username;
  if (!out.password && stored.password) out.password = stored.password;
  if (!out.baseUrl && stored.baseUrl) out.baseUrl = stored.baseUrl;
  return out;
}

/**
 * When the UI names an existing profile, start from it and overlay only the
 * fields the operator actually typed — so ccms.json's 45 hand-tuned routes,
 * per-route setup steps and recipes are preserved.
 */
function configFromProfile(profileName, body) {
  const base = loadConfig(profileName);
  if (body.baseUrl) base.baseUrl = String(body.baseUrl).replace(/\/+$/, '');
  if (body.username) base.credentials.username = body.username;
  if (body.password) base.credentials.password = body.password;
  if (body.viewportWidth) base.browser.viewport.width = Number(body.viewportWidth);
  if (body.viewportHeight) base.browser.viewport.height = Number(body.viewportHeight);
  if (body.headless !== undefined) base.browser.headless = body.headless !== false;
  if (body.readOnly !== undefined) base.safety.readOnly = body.readOnly !== false;
  return base;
}

function buildConfig(rawBody) {
  const body = applyStoredCredentials(rawBody);
  return body.profile ? configFromProfile(body.profile, body) : makeConfig(configFromForm(body));
}

// -------------------------------------------------------------------- routes

app.get('/api/profiles', (req, res) => {
  const profiles = listProfiles().map((name) => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', `${name}.json`), 'utf-8'));
      return {
        name,
        displayName: raw.displayName || name,
        baseUrl: raw.baseUrl || '',
        routeCount: (raw.routes || []).length,
        authStrategy: (raw.auth && raw.auth.strategy) || 'form',
      };
    } catch (e) {
      return { name, displayName: name, baseUrl: '', routeCount: 0 };
    }
  });
  res.json({ profiles });
});

/**
 * What we already know, so the form can prefill itself. The password is never
 * sent to the browser — only whether one is stored.
 */
app.get('/api/defaults', (req, res) => {
  const stored = storedCredentials(req.query.app || '');
  res.json({
    username: stored.username,
    hasStoredPassword: !!stored.password,
    baseUrl: stored.baseUrl,
    // Which description mode is available without further setup.
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
  });
});

/**
 * Build a whole profile from a URL and credentials: log in, walk the sidebar,
 * enumerate the reports behind the report selector, probe the standard
 * account/support screens, and drop anything that does not actually open.
 */
app.post('/api/profile/generate', async (req, res) => {
  if (state.running) {
    return res.status(409).json({ ok: false, error: 'A run is already in progress.' });
  }
  const body = applyStoredCredentials(req.body);
  state.running = true;
  state.lines = [];
  log.setSink(addLine);
  push('start', { app: body.name, displayName: body.name, mode: 'profile' });

  try {
    const r = await generateProfile({
      name: body.name,
      baseUrl: body.baseUrl,
      username: body.username,
      password: body.password,
    });
    push('profile', { name: r.name, routes: r.routes.length, dropped: r.dropped.length });
    res.json({
      ok: true, name: r.name, routes: r.routes,
      dropped: r.dropped.map((d) => ({ name: d.name, path: d.path })),
    });
  } catch (e) {
    addLine({ level: 'error', message: e.message });
    push('failed', { error: e.message });
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    state.running = false;
    log.setSink(null);
  }
});

/** Log in and walk the nav — lets the operator see the screen list before running. */
app.post('/api/discover', async (req, res) => {
  let browser;
  try {
    const cfg = buildConfig(req.body);
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      viewport: cfg.browser.viewport,
      ignoreHTTPSErrors: cfg.browser.ignoreHTTPSErrors,
    });
    await authenticate(ctx, cfg);
    const routes = await discoverRoutes(ctx, cfg);
    res.json({ ok: true, routes });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.post('/api/run', async (req, res) => {
  if (state.running) {
    return res.status(409).json({ ok: false, error: 'A capture run is already in progress.' });
  }

  let cfg;
  try {
    cfg = buildConfig(req.body);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }

  state.running = true;
  state.id = `${cfg.name}-${Date.now()}`;
  state.lines = [];
  state.result = null;
  state.error = null;
  state.progress = { done: 0, total: (cfg.routes || []).length, captures: 0, route: null };

  res.json({ ok: true, runId: state.id, app: cfg.name });

  log.setSink(addLine);
  push('start', { runId: state.id, app: cfg.name, displayName: cfg.displayName });

  run(cfg, {
    only: req.body.only || null,
    limit: req.body.limit || null,
    onProgress: (p) => {
      state.progress = p;
      push('progress', p);
    },
  })
    .then(async (manifest) => {
      state.result = {
        app: cfg.name,
        runId: manifest.runId,
        stats: manifest.stats,
        durationSec: manifest.durationSec,
      };

      // Optional follow-on stages, each requested by its own checkbox.
      const wantDescribe = req.body.describe || req.body.manual;
      if (wantDescribe) {
        push('stage', { stage: 'describe' });
        const d = await generateDescriptions(cfg.runDir, {
          mode: req.body.descriptionMode || 'auto',
          force: !!req.body.forceDescriptions,
          onProgress: (p) => push('progress', {
            done: p.done, total: p.total, captures: state.progress.captures, route: p.screen,
          }),
        }).catch((e) => { log.error(`descriptions: ${e.message}`); return null; });
        if (d) state.result.descriptions = { mode: d.mode, covered: d.covered, total: d.total };
      }
      if (req.body.manual) {
        push('stage', { stage: 'manual' });
        try {
          const m = generateManual(cfg.runDir);
          state.result.manual = { described: m.described, total: m.total };
          log.ok(`Manual built — ${m.described} of ${m.total} illustrations described`);
        } catch (e) {
          log.error(`manual: ${e.message}`);
        }
      }
      push('done', state.result);
    })
    .catch((e) => {
      state.error = e.message;
      addLine({ level: 'error', message: e.message });
      push('failed', { error: e.message });
    })
    .finally(() => {
      state.running = false;
      log.setSink(null);
    });
});

/**
 * Clear a stuck run flag. The capture itself runs in this process, so this
 * releases the lock rather than killing work mid-flight — it exists for the
 * case where a run died without unwinding and the UI is left disabled.
 */
app.post('/api/run/reset', (req, res) => {
  const was = state.running;
  state.running = false;
  state.error = null;
  log.setSink(null);
  push('failed', { error: 'Run state was reset.' });
  res.json({ ok: true, wasRunning: was });
});

app.get('/api/run/status', (req, res) => {
  res.json({
    running: state.running,
    runId: state.id,
    progress: state.progress,
    result: state.result,
    error: state.error,
    lines: state.lines.slice(-400),
  });
});

/** Server-sent events: live log + progress for the active run. */
app.get('/api/run/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ running: state.running })}\n\n`);
  state.lines.slice(-200).forEach((l) => res.write(`event: log\ndata: ${JSON.stringify(l)}\n\n`));

  state.clients.push(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    state.clients = state.clients.filter((c) => c !== res);
  });
});

/** Every completed run across every app, newest first. */
app.get('/api/runs', (req, res) => {
  const runs = [];
  if (fs.existsSync(OUTPUT_ROOT)) {
    for (const appName of fs.readdirSync(OUTPUT_ROOT)) {
      const appDir = path.join(OUTPUT_ROOT, appName);
      if (!fs.statSync(appDir).isDirectory()) continue;
      for (const runId of fs.readdirSync(appDir)) {
        const manifestPath = path.join(appDir, runId, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          runs.push({
            app: appName,
            runId,
            displayName: m.app.displayName,
            baseUrl: m.app.baseUrl,
            startedAt: m.startedAt,
            durationSec: m.durationSec,
            stats: m.stats,
            viewport: m.app.viewport,
          });
        } catch (e) { /* skip unreadable run */ }
      }
    }
  }
  runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  res.json({ runs });
});

app.get('/api/runs/:app/:runId', (req, res) => {
  const file = path.join(OUTPUT_ROOT, req.params.app, req.params.runId, 'manifest.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Run not found' });
  res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
});

// ------------------------------------------------------------- static client

const CLIENT_DIST = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api|shots).*/, (req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
} else {
  app.get('/', (req, res) => {
    res.status(503).send(
      '<h1>AppShot UI is not built yet</h1>' +
      '<p>Run <code>npm run ui:build</code> once, then restart with <code>npm run ui</code>.</p>' +
      '<p>For development, run <code>npm run ui:dev</code> and open the Vite URL instead.</p>'
    );
  });
}

app.listen(PORT, () => {
  console.log(`\n  AppShot UI  ->  http://localhost:${PORT}\n`);
});
