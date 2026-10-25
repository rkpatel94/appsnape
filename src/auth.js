/**
 * auth.js — pluggable login strategies.
 *
 * 'api'   Call the login endpoint directly, then inject the resulting token /
 *         user object into sessionStorage / localStorage / cookies BEFORE the
 *         first navigation. This is the fastest and most reliable strategy, and
 *         it is the only one that works for SPAs which keep auth in
 *         sessionStorage (Playwright's storageState does NOT persist
 *         sessionStorage).
 * 'form'  Drive the real login screen. Slower, but needs no API knowledge —
 *         the right default for an app you are pointing the tool at for the
 *         first time.
 * 'none'  Public app, no login.
 */
const { log } = require('./logger');

/** Read 'a.b.c' out of an object; 'a.b::json' returns JSON.stringify of it. */
function extract(source, spec) {
  const asJson = spec.endsWith('::json');
  const dotted = asJson ? spec.slice(0, -6) : spec;
  const value = dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), source);
  if (value === undefined || value === null) return null;
  return asJson ? JSON.stringify(value) : String(value);
}

function buildBody(template, creds) {
  const json = JSON.stringify(template)
    .replace(/\{\{username\}\}/g, creds.username || '')
    .replace(/\{\{password\}\}/g, creds.password || '');
  return JSON.parse(json);
}

async function apiLogin(context, cfg) {
  const { api } = cfg.auth;
  if (!api.endpoint) throw new Error('auth.api.endpoint is required for strategy "api"');

  const url = api.endpoint.startsWith('http') ? api.endpoint : cfg.baseUrl + api.endpoint;
  const body = buildBody(api.body, cfg.credentials);

  log.step(`POST ${url}`);
  const res = await context.request.fetch(url, {
    method: api.method || 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, api.headers),
    data: body,
  });

  if (!res.ok()) {
    const text = await res.text().catch(() => '');
    throw new Error(`Login API returned ${res.status()} ${res.statusText()}\n${text.slice(0, 500)}`);
  }

  let payload;
  try {
    payload = await res.json();
  } catch (e) {
    throw new Error('Login API did not return JSON. Check auth.api.endpoint.');
  }

  const session = {};
  for (const [key, spec] of Object.entries(api.sessionStorage || {})) {
    const v = extract(payload, spec);
    if (v === null) log.warn(`sessionStorage."${key}": path "${spec}" not found in login response`);
    else session[key] = v;
  }
  const local = {};
  for (const [key, spec] of Object.entries(api.localStorage || {})) {
    const v = extract(payload, spec);
    if (v === null) log.warn(`localStorage."${key}": path "${spec}" not found in login response`);
    else local[key] = v;
  }

  if (!Object.keys(session).length && !Object.keys(local).length && !(api.cookies || []).length) {
    throw new Error(
      'Login succeeded but no storage mapping produced a value. ' +
      'Configure auth.api.sessionStorage / localStorage / cookies.'
    );
  }

  // Injected as an init script so the values exist on the very first paint —
  // an SPA that reads the token during bootstrap would otherwise bounce to login.
  await context.addInitScript(({ s, l }) => {
    try {
      for (const [k, v] of Object.entries(s)) sessionStorage.setItem(k, v);
      for (const [k, v] of Object.entries(l)) localStorage.setItem(k, v);
    } catch (e) { /* storage blocked - surfaced by the verify step */ }
  }, { s: session, l: local });

  if ((api.cookies || []).length) {
    const host = new URL(cfg.baseUrl).hostname;
    const cookies = api.cookies
      .map((c) => {
        const value = extract(payload, c.path);
        if (value === null) return null;
        return { name: c.name, value, domain: c.domain || host, path: c.cookiePath || '/' };
      })
      .filter(Boolean);
    if (cookies.length) await context.addCookies(cookies);
  }

  const injected = [...Object.keys(session), ...Object.keys(local)];
  log.ok(`Auth injected (${injected.join(', ')})`);
  return payload;
}

async function formLogin(context, cfg) {
  const f = cfg.auth.form;
  const page = await context.newPage();
  const url = cfg.baseUrl + (f.loginPath || '/');
  log.step(`Opening login page ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  await page.locator(f.usernameSelector).first().fill(cfg.credentials.username || '');
  await page.locator(f.passwordSelector).first().fill(cfg.credentials.password || '');

  for (const step of f.extraSteps || []) {
    if (step.action === 'fill') await page.locator(step.selector).first().fill(step.value || '');
    else if (step.action === 'click') await page.locator(step.selector).first().click();
    else if (step.action === 'wait') await page.waitForTimeout(Number(step.value) || 500);
  }

  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
    page.locator(f.submitSelector).first().click(),
  ]);
  await page.waitForTimeout(1500);
  log.ok(`Submitted login form as "${cfg.credentials.username}"`);
  await page.close();
}

/** Confirm we are actually inside the app, not bounced back to a login screen. */
async function verify(context, cfg) {
  const v = cfg.auth.verify || {};
  const target = cfg.baseUrl + (v.path || '/');
  const page = await context.newPage();
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: v.timeout || 30000 });
    await page.waitForTimeout(1200);

    if (v.selector) {
      await page.locator(v.selector).first().waitFor({ state: 'visible', timeout: v.timeout || 30000 });
    }
    const landed = page.url();
    const stillOnLogin = /login|signin/i.test(landed) ||
      (await page.locator('input[type="password"]').count()) > 0;
    if (stillOnLogin) {
      throw new Error(`Redirected to a login screen (${landed}) - credentials or auth mapping are wrong.`);
    }
    log.ok(`Session verified at ${landed}`);
  } finally {
    await page.close();
  }
}

async function authenticate(context, cfg) {
  log.group('Authenticating');
  try {
    const strategy = (cfg.auth.strategy || 'form').toLowerCase();
    if (strategy === 'none') { log.skip('strategy: none'); }
    else if (strategy === 'api') { await apiLogin(context, cfg); }
    else if (strategy === 'form') { await formLogin(context, cfg); }
    else throw new Error(`Unknown auth.strategy "${strategy}" (use none | api | form)`);

    if (strategy !== 'none') await verify(context, cfg);
  } finally {
    log.groupEnd();
  }
}

module.exports = { authenticate, extract };
