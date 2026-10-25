/**
 * discover.js — build a route map by walking the app's own navigation.
 *
 * This is what makes the tool "point it at a new app and go": rather than
 * hand-listing screens, expand every collapsible menu group in the sidebar and
 * harvest the links, keeping the menu hierarchy as the module grouping so the
 * generated inventory mirrors how the app presents itself.
 *
 * Discovered routes are a starting point — write them into the profile with
 * `appshot discover --app <name> --save` and then hand-tune.
 */
const { log } = require('./logger');
const { waitForStable } = require('./stabilize');

const HARVEST = (navSelectors) => {
  const text = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const roots = [];
  for (const sel of navSelectors) {
    document.querySelectorAll(sel).forEach((n) => { if (!roots.includes(n)) roots.push(n); });
  }
  if (!roots.length) roots.push(document.body);

  const out = [];
  for (const root of roots) {
    root.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const label = text(a) || a.getAttribute('title') || a.getAttribute('aria-label') || '';
      const r = a.getBoundingClientRect();
      if (!label) return;

      // Walk up looking for the enclosing menu group's own label, so
      // "Equipment Master" is filed under "Master Configuration".
      let group = '';
      let p = a.parentElement;
      let hops = 0;
      while (p && p !== root && hops < 8) {
        const cand = p.querySelector(':scope > [aria-expanded], :scope > button, :scope > div > button, :scope > .group-label');
        if (cand && !cand.contains(a)) { group = text(cand); if (group) break; }
        p = p.parentElement; hops += 1;
      }
      out.push({ href, label, group, visible: r.width > 0 && r.height > 0 });
    });
  }
  return out;
};

async function expandNav(page, cfg) {
  const d = cfg.discovery;
  for (let pass = 0; pass < d.expandPasses; pass++) {
    const clicked = await page.evaluate(({ navSelectors, expandSelectors }) => {
      const roots = [];
      for (const sel of navSelectors) {
        document.querySelectorAll(sel).forEach((n) => { if (!roots.includes(n)) roots.push(n); });
      }
      if (!roots.length) roots.push(document.body);
      let n = 0;
      for (const root of roots) {
        for (const sel of expandSelectors) {
          root.querySelectorAll(sel).forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { el.click(); n += 1; }
          });
        }
      }
      return n;
    }, { navSelectors: d.navSelectors, expandSelectors: d.expandSelectors }).catch(() => 0);

    if (!clicked) break;
    await page.waitForTimeout(500);
  }
}

function toPath(href, baseUrl) {
  if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return null;
  try {
    const u = new URL(href, baseUrl);
    if (new URL(baseUrl).host !== u.host) return null;   // external link
    return u.pathname + (u.search || '');
  } catch (e) {
    return null;
  }
}

function slugify(s) {
  return String(s).trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').slice(0, 60);
}

function titleFromPath(p) {
  const last = p.split('/').filter(Boolean).pop() || 'home';
  return last.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function discoverRoutes(context, cfg) {
  log.group('Discovering routes from navigation');
  const page = await context.newPage();
  try {
    const start = cfg.baseUrl + (cfg.auth.verify.path || '/');
    await page.goto(start, { waitUntil: 'domcontentloaded' });
    await waitForStable(page, cfg);

    await expandNav(page, cfg);
    await page.waitForTimeout(400);

    const raw = await page.evaluate(HARVEST, cfg.discovery.navSelectors).catch(() => []);
    log.step(`${raw.length} link(s) found in navigation`);

    const include = (cfg.discovery.includePatterns || []).map((p) => new RegExp(p, 'i'));
    const exclude = (cfg.discovery.excludePatterns || []).map((p) => new RegExp(p, 'i'));

    const seen = new Set();
    const routes = [];
    for (const item of raw) {
      const p = toPath(item.href, cfg.baseUrl);
      if (!p) continue;
      if (include.length && !include.some((r) => r.test(p))) continue;
      if (exclude.some((r) => r.test(p) || r.test(item.label))) continue;
      if (p.includes(':')) continue;                 // un-substituted param route
      if (seen.has(p)) continue;
      seen.add(p);

      routes.push({
        path: p,
        name: item.label || titleFromPath(p),
        module: item.group || titleFromPath('/' + (p.split('/').filter(Boolean)[0] || 'general')),
        slug: slugify(item.label || titleFromPath(p)),
      });
      if (routes.length >= cfg.discovery.maxRoutes) break;
    }

    log.ok(`${routes.length} route(s) after filtering`);
    return routes;
  } finally {
    await page.close();
    log.groupEnd();
  }
}

module.exports = { discoverRoutes, slugify, titleFromPath };
