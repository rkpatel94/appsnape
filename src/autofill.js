/**
 * autofill.js — make filtered screens show data instead of an empty state.
 *
 * Most report and dashboard screens open with a filter that returns nothing:
 * a date range defaulted to today, or a required person/category left unset.
 * Capturing those produces a folder of empty tables, which documents nothing.
 *
 * This fills the filter in generically — widen the date range, choose the
 * preferred user, pick the first option for anything else required — and then
 * presses the screen's own apply/view control.
 *
 * SAFETY — the important part. This must never type into a data-entry form
 * (a Change Control, a CAPA record). Two guards:
 *   1. Routes whose path looks like add/edit/create are skipped outright.
 *   2. It only acts when the screen has a recognisable apply control (View /
 *      Apply Filter / Search) and only touches fields inside that control's
 *      own container. A form whose button is "Submit" or "Save" is not a
 *      filter panel and is left alone.
 */
const { log } = require('./logger');
const { waitForStable } = require('./stabilize');

const PANEL_ATTR = 'data-appshot-panel';

/**
 * Dashboards hide their date filter behind an icon-only button, so there is no
 * apply control on screen until it is opened. Find that toggle and click it.
 *
 * Candidates are ranked: anything actually labelled "filter" first, then
 * icon-only buttons in the upper content area. Buttons inside tables are never
 * touched — those are row actions (view, edit, delete), not filters.
 */
async function openCollapsedFilter(page, cfg) {
  const candidates = await page.evaluate(() => {
    const out = [];
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    btns.forEach((b, i) => {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (b.closest('table, thead, tbody, [role="row"], nav, header, aside')) return;
      if (r.top > 600) return;                        // filters live near the top
      const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
      const meta = `${b.getAttribute('title') || ''} ${b.getAttribute('aria-label') || ''} ${b.className || ''}`;
      const named = /filter/i.test(meta) || /^filters?$/i.test(text);
      const iconOnly = !text && b.querySelector('svg');
      if (named || iconOnly) {
        b.setAttribute('data-appshot-toggle', String(i));
        out.push({ i, named, text });
      }
    });
    return out.sort((a, b2) => (b2.named ? 1 : 0) - (a.named ? 1 : 0)).slice(0, 4);
  }).catch(() => []);

  for (const c of candidates) {
    const btn = page.locator(`[data-appshot-toggle="${c.i}"]`).first();
    if (!(await btn.isVisible().catch(() => false))) continue;
    await btn.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(700);

    const opened = await page.evaluate((pattern) => {
      const re = new RegExp(pattern, 'i');
      return Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter((b) => b.getBoundingClientRect().width > 0)
        .some((b) => re.test((b.textContent || '').replace(/\s+/g, ' ').trim()));
    }, cfg.autoFilter.applyButtons).catch(() => false);

    if (opened) return true;
    // Wrong button — put it back the way we found it.
    await btn.click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }
  return false;
}

async function clearToggleMarks(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-appshot-toggle]').forEach((e) => e.removeAttribute('data-appshot-toggle'));
  }).catch(() => {});
}

/** Locate the apply control and tag the container holding it and its fields. */
async function markFilterPanel(page, applyPattern) {
  return page.evaluate(({ pattern, attr }) => {
    document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr));
    const re = new RegExp(pattern, 'i');

    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .filter((b) => re.test((b.textContent || '').replace(/\s+/g, ' ').trim()));
    if (!buttons.length) return { found: false };

    const btn = buttons[0];
    const label = (btn.textContent || '').replace(/\s+/g, ' ').trim();

    // Walk up until the container also holds input controls — that is the panel.
    let panel = btn.parentElement;
    let hops = 0;
    while (panel && hops < 8) {
      const fields = panel.querySelectorAll('input, [role="combobox"], select');
      if (fields.length > 0) break;
      panel = panel.parentElement;
      hops += 1;
    }
    if (!panel) return { found: false };

    panel.setAttribute(attr, '1');
    return {
      found: true,
      applyLabel: label,
      fieldCount: panel.querySelectorAll('input, [role="combobox"], select').length,
    };
  }, { pattern: applyPattern, attr: PANEL_ATTR }).catch(() => ({ found: false }));
}

async function clearPanelMark(page) {
  await page.evaluate((attr) => {
    document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr));
  }, PANEL_ATTR).catch(() => {});
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

function isoStartOfYear() {
  return `${new Date().getFullYear()}-01-01`;
}

/**
 * Widen the date range. Segmented pickers (MUI X) are not real inputs, so the
 * value is typed digit by digit into the first section.
 *
 * Some screens tie the range to a separate Year field and reject a start date
 * outside it, so when a Year control is present the range starts on 1 January
 * of the current year instead of a rolling twelve months.
 */
async function setStartDate(page, iso) {
  const panel = page.locator(`[${PANEL_ATTR}]`);
  const [y, m, d] = iso.split('-');

  // Segmented picker first — the common case in these apps.
  const daySections = panel.locator('[role="spinbutton"][aria-label="Day"]');
  const segCount = await daySections.count().catch(() => 0);
  if (segCount > 0) {
    await daySections.nth(0).click();
    await page.keyboard.type(d + m + y, { delay: 55 });
    await page.waitForTimeout(350);
    return { changed: true, from: iso };
  }

  // Plain date inputs.
  const dateInputs = panel.locator('input[type="date"]');
  if ((await dateInputs.count().catch(() => 0)) > 0) {
    await dateInputs.nth(0).fill(iso);
    await dateInputs.nth(0).dispatchEvent('change').catch(() => {});
    await page.waitForTimeout(250);
    return { changed: true, from: iso };
  }
  return { changed: false };
}

/** Does the panel currently show a validation complaint? */
async function panelHasError(page) {
  return page.evaluate((attr) => {
    const panel = document.querySelector(`[${attr}]`);
    if (!panel) return null;
    const nodes = Array.from(panel.querySelectorAll('*')).filter((el) => {
      if (el.children.length) return false;
      const s = getComputedStyle(el);
      const c = s.color || '';
      const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      const reddish = m && Number(m[1]) > 150 && Number(m[2]) < 110 && Number(m[3]) < 110;
      const flagged = el.classList.contains('Mui-error') || el.closest('.Mui-error');
      return (reddish || flagged) && el.getBoundingClientRect().width > 0;
    });
    const texts = nodes.map((n) => (n.textContent || '').trim())
      .filter((t) => t.length > 3 && t.length < 160 && /must|invalid|cannot|required|within|exceed/i.test(t));
    return texts[0] || null;
  }, PANEL_ATTR).catch(() => null);
}

/**
 * Widen the range to the configured window. Some screens tie the range to a
 * separate Year field and reject a start date outside it — rather than trying
 * to recognise every such control, set the wide range, look for the app's own
 * complaint, and fall back to 1 January of the current year.
 */
async function widenDateRange(page, cfg) {
  const wide = isoDaysAgo(cfg.autoFilter.rangeDays);
  const res = await setStartDate(page, wide);
  if (!res.changed) return res;

  await page.waitForTimeout(400);                 // let validation render
  const err = await panelHasError(page);
  if (err) {
    const fallback = isoStartOfYear();
    await setStartDate(page, fallback);
    return { changed: true, from: fallback, constrained: err, usedWide: false };
  }
  return { changed: true, from: wide, usedWide: true };
}

/**
 * Work out, in the page, which selection lists are required and which look
 * like a person. Filling an OPTIONAL category filter is actively harmful: on
 * the CAPA Initiation Report, defaulting Department, CAPA Type, Status and
 * Source Type all at once narrowed the query to "No data found". Only required
 * fields (and user pickers, which are wanted deliberately) get filled.
 */
async function classifyCombos(page) {
  return page.evaluate((attr) => {
    const panel = document.querySelector(`[${attr}]`);
    if (!panel) return [];
    const combos = Array.from(panel.querySelectorAll('[role="combobox"]'));
    return combos.map((el, index) => {
      // Find the field's label by walking up to the wrapper that holds one.
      let label = '';
      let p = el;
      for (let i = 0; i < 5 && p; i++) {
        p = p.parentElement;
        if (!p) break;
        const l = p.querySelector('label, .MuiFormLabel-root');
        if (l) { label = (l.textContent || '').replace(/\s+/g, ' ').trim(); break; }
      }
      const hint = [
        el.id || '', el.getAttribute('name') || '',
        el.getAttribute('placeholder') || '', el.getAttribute('aria-label') || '', label,
      ].join(' ').toLowerCase();

      const required = /\*\s*$/.test(label) || el.getAttribute('aria-required') === 'true';
      const value = (el.value || el.textContent || '').trim();
      return {
        index,
        label,
        required,
        empty: !value,
        isUser: /user|person|employee|performed by|assigned|allocated user|owner/.test(hint),
      };
    });
  }, PANEL_ATTR).catch(() => []);
}

/**
 * Fill the selection lists that need a value: required ones, plus any person
 * picker (which is set to the configured user on purpose). Optional category
 * filters are deliberately left at their default.
 */
async function fillEmptySelections(page, cfg) {
  const panel = page.locator(`[${PANEL_ATTR}]`);
  const combos = panel.locator('[role="combobox"]');
  const meta = await classifyCombos(page);
  const n = Math.min(await combos.count().catch(() => 0), cfg.autoFilter.maxFields);
  const filled = [];
  const skipped = [];

  for (let i = 0; i < n; i++) {
    const info = meta[i] || {};
    if (!info.empty) continue;
    const isUserField = !!info.isUser;
    // Only required fields get filled. An optional person filter is still a
    // filter: setting it narrows the report to one individual's records, which
    // is not what "show this screen with data in it" means.
    if (!info.required) {
      if (info.label) skipped.push(info.label);
      continue;
    }

    const combo = combos.nth(i);
    if (!(await combo.isVisible().catch(() => false))) continue;
    if (!(await combo.isEnabled().catch(() => true))) continue;

    await combo.click().catch(() => {});
    await page.waitForTimeout(450);
    const options = page.locator('[role="option"]');
    const optCount = await options.count().catch(() => 0);
    if (!optCount) { await page.keyboard.press('Escape').catch(() => {}); continue; }

    let picked = null;
    if (isUserField && cfg.autoFilter.preferredUser) {
      const preferred = options
        .filter({ hasText: new RegExp(cfg.autoFilter.preferredUser, 'i') }).first();
      if (await preferred.isVisible().catch(() => false)) {
        picked = (await preferred.innerText().catch(() => '')).trim();
        await preferred.click().catch(() => {});
      } else {
        // Say so rather than quietly documenting somebody else's records.
        log.warn(`autofill: "${cfg.autoFilter.preferredUser}" not offered — using the first entry instead`);
      }
    }
    if (!picked) {
      picked = (await options.nth(0).innerText().catch(() => '')).trim();
      await options.nth(0).click().catch(() => {});
    }
    await page.waitForTimeout(350);
    filled.push(`${isUserField ? 'user' : (info.label || 'field').replace(/\s*\*$/, '')}=${picked}`);
  }
  if (skipped.length) {
    log.step(`autofill: left optional filters at default (${skipped.join(', ')})`);
  }
  return filled;
}

/** Did the screen come back with nothing? Worth saying out loud. */
async function looksEmpty(page) {
  return page.evaluate(() => {
    const body = document.body.innerText || '';
    if (/no data found|no record|0[–-]0 of 0/i.test(body)) return true;
    const rows = document.querySelectorAll('tbody tr').length;
    return rows === 0 && /rows per page/i.test(body);
  }).catch(() => false);
}

/**
 * Put a filtered screen into a state that returns data, then apply it.
 * Returns a short summary, or null when the screen is not a filter screen.
 */
async function autoFillFilters(page, cfg, route) {
  const af = cfg.autoFilter;
  if (!af || !af.enabled) return null;

  const routePath = (route && route.path) || '';
  if (af.skipPathPattern && new RegExp(af.skipPathPattern, 'i').test(routePath)) return null;
  if (route && route.autoFilter === false) return null;

  let panel = await markFilterPanel(page, af.applyButtons);
  let opened = false;
  if (!panel.found) {
    // No apply control on screen — the filter may be collapsed behind an icon,
    // which is how every dashboard here works.
    opened = await openCollapsedFilter(page, cfg);
    await clearToggleMarks(page);
    if (!opened) return null;
    panel = await markFilterPanel(page, af.applyButtons);
    if (!panel.found) return null;
  }

  try {
    const dates = await widenDateRange(page, cfg).catch(() => ({ changed: false }));
    const filled = await fillEmptySelections(page, cfg).catch(() => []);

    const applyBtn = page.locator(`[${PANEL_ATTR}]`)
      .getByRole('button', { name: new RegExp(af.applyButtons, 'i') }).first();
    const apply = async () => {
      if (await applyBtn.isVisible().catch(() => false)) {
        await applyBtn.click({ timeout: cfg.interactions.perActionTimeout }).catch(() => {});
        await page.waitForTimeout(600);
      }
      await waitForStable(page, cfg);
    };
    await apply();

    // Some screens reject an out-of-year start date without saying so clearly —
    // they simply return nothing. If a wide range produced no rows, narrow to
    // the current year and try once more before accepting the empty result.
    if (dates.usedWide && (await looksEmpty(page))) {
      await setStartDate(page, isoStartOfYear());
      await apply();
      dates.from = isoStartOfYear();
      dates.retried = true;
    }

    const bits = [];
    if (dates.changed) {
      bits.push(`dates from ${dates.from}${dates.constrained ? ' (narrowed — app said: ' + dates.constrained + ')' : ''}${dates.retried ? ' (narrowed to this year — the wider range returned nothing)' : ''}`);
      if (dates.unresolved) log.warn(`autofill: date still rejected — ${dates.unresolved}`);
    }
    if (filled.length) bits.push(filled.join(', '));
    bits.push(`applied "${panel.applyLabel}"`);
    if (await looksEmpty(page)) {
      bits.push('NOTE: still no rows — this screen may genuinely have no data for the period');
    }
    return bits.join('; ');
  } finally {
    await clearPanelMark(page);
  }
}

module.exports = { autoFillFilters };
