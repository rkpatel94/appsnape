/**
 * interactions.js — the "proper navigation" part.
 *
 * A screen is not documented by one screenshot of its landing state. What a
 * tester actually needs is the grid, the grid's second page, the filter panel
 * open, the Add form, the View detail, the Edit form. These recipes reproduce
 * that walk generically, driven by role/text heuristics rather than
 * app-specific selectors, so the same code works on the next application.
 *
 * SAFETY: every click goes through safeClick(), which refuses any control whose
 * accessible name looks like a commit (Save / Submit / Delete / Approve /
 * Confirm / Sign...). Combined with the runner's PUT/PATCH/DELETE network
 * guard, a capture run opens forms but never writes. That is deliberate: these
 * apps are GxP-regulated and the tool must be safe to point at validated
 * environments.
 */
const { log } = require('./logger');
const { waitForStable } = require('./stabilize');
const { autoFillFilters } = require('./autofill');

class BlockedClickError extends Error {}

function accessibleName(text, aria, title) {
  return (text || aria || title || '').replace(/\s+/g, ' ').trim();
}

async function safeClick(locator, cfg, what) {
  const raw = await locator.innerText().catch(() => '');
  const aria = await locator.getAttribute('aria-label').catch(() => null);
  const title = await locator.getAttribute('title').catch(() => null);
  const name = accessibleName(raw, aria, title);

  if (cfg.safety.readOnly && name) {
    const deny = new RegExp(cfg.safety.denyClickText, 'i');
    if (deny.test(name)) {
      throw new BlockedClickError(`refused to click "${name}" (${what}) - read-only mode`);
    }
  }
  await locator.click({ timeout: cfg.interactions.perActionTimeout });
  return name;
}

/**
 * Is a pop-up window open?
 *
 * Plenty of these screens build one without role="dialog" — the FMN "Add
 * Parameter" window is a plain fixed-position div — so a raised, fixed panel
 * of real size counts as one too.
 */
async function dialogOpen(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    if (Array.from(document.querySelectorAll('[role="dialog"]')).some(vis)) return true;
    return Array.from(document.querySelectorAll('div')).some((el) => {
      if (!vis(el)) return false;
      const s = getComputedStyle(el);
      if (s.position !== 'fixed') return false;
      if (parseInt(s.zIndex || '0', 10) < 10) return false;
      const r = el.getBoundingClientRect();
      return r.width > 300 && r.height > 150 && (el.textContent || '').trim().length > 10;
    });
  }).catch(() => false);
}

/** Close a pop-up window without saving anything. */
async function closeDialog(page) {
  if (!(await dialogOpen(page))) return;

  const dlg = page.locator('[role="dialog"]').first();
  if (await dlg.isVisible().catch(() => false)) {
    const inDlg = dlg.locator('button').filter({ hasText: /^(cancel|close|back)$/i }).first();
    if (await inDlg.isVisible().catch(() => false)) {
      await inDlg.click({ timeout: 4000 }).catch(() => {});
      await dlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      return;
    }
  }

  // A window with no role: reach for its own Cancel, then fall back to Escape.
  const cancel = page.locator('button', { hasText: /^\s*(cancel|close|back)\s*$/i }).last();
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click({ timeout: 4000, force: true }).catch(() => {});
    await page.waitForTimeout(700);
  }
  if (await dialogOpen(page)) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
  }
}

/** A view of ctx whose captures are all named under one prefix. */
function prefixed(ctx, prefix) {
  if (!prefix) return ctx;
  return Object.assign({}, ctx, {
    shoot: (label, opts) => ctx.shoot(prefix + '_' + label, opts),
  });
}

/**
 * Some "Add" buttons open a small menu rather than going anywhere — DVMS offers
 * "Add New Deviation" and "Reopen Deviation" under one Add Deviation button.
 * The panel is a plain absolutely-positioned div, not a role="menu", so this
 * looks for buttons that appeared after the click and takes the one that
 * starts something new.
 */
async function readAddMenu(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    document.querySelectorAll('[data-appshot-menu]').forEach((e) => e.removeAttribute('data-appshot-menu'));

    const panels = Array.from(document.querySelectorAll('div, ul')).filter((el) => {
      const s = getComputedStyle(el);
      if (!vis(el) || (s.position !== 'absolute' && s.position !== 'fixed')) return false;
      const r = el.getBoundingClientRect();
      // A menu is small and holds a handful of choices. A form that happens to
      // float is large and holds inputs, so those two tests keep them apart.
      if (r.height > 500 || r.width > 520) return false;
      if (el.querySelector('input, textarea, select')) return false;
      const items = el.querySelectorAll('button, a, [role="menuitem"]');
      return items.length > 0 && items.length <= 8;
    });
    if (!panels.length) return [];

    // The innermost panel is the menu itself rather than a wrapper around it.
    const panel = panels.filter((p) => !panels.some((q) => q !== p && p.contains(q))).pop() || panels[0];
    const out = [];
    panel.querySelectorAll('button, a, [role="menuitem"]').forEach((el) => {
      if (!vis(el)) return;
      // Menu entries often carry a heading and a line of explanation under it.
      // textContent runs the two together ("Revise DocumentUse existing
      // document"), which makes a poor capture label, so take the heading.
      const kids = Array.from(el.children).filter((c) => (c.textContent || '').trim());
      const raw = kids.length ? kids[0].textContent : el.textContent;
      const text = (raw || '').replace(/\s+/g, ' ').trim();
      if (!text || /^(close|cancel|×|x)$/i.test(text)) return;
      el.setAttribute('data-appshot-menu', String(out.length));
      out.push({ i: out.length, text: text.slice(0, 40) });
    });
    return out;
  }).catch(() => []);
}


/** Click one entry of the menu read above. Returns false if it has gone. */
async function clickAddMenuItem(page, cfg, index) {
  const el = page.locator('[data-appshot-menu="' + index + '"]').first();
  if (!(await el.isVisible().catch(() => false))) return false;
  await el.click({ timeout: cfg.interactions.perActionTimeout }).catch(() => {});
  await page.waitForTimeout(1200);
  await waitForStable(page, cfg);
  return true;
}

/**
 * Work through the controls inside an opened form.
 *
 * A form is not documented by one picture of it: its sections start collapsed,
 * and the rows it holds are added through their own pop-up windows. This opens
 * each section, then presses each "Add ..." control and captures whatever it
 * produces — a pop-up window, or a new inline row. Nothing is ever saved: the
 * pop-up is closed with Cancel, and Save/Submit are refused by safeClick.
 */
async function formActions(page, ctx) {
  const buttons = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    document.querySelectorAll('[data-appshot-fa]').forEach((e) => e.removeAttribute('data-appshot-fa'));
    const out = [];
    Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((el) => vis(el) && !el.closest('nav, aside, header, [role="dialog"]'))
      .filter((el) => /^\+?\s*(add|create|new)\b/i.test((el.textContent || '').replace(/\s+/g, ' ').trim()))
      .forEach((el, i) => {
        el.setAttribute('data-appshot-fa', String(i));
        // Name the capture after the section the control sits in.
        let section = '';
        let p = el.parentElement;
        for (let k = 0; k < 6 && p; k++) {
          const h = p.querySelector('h1,h2,h3,h4,h5');
          if (h) { section = (h.textContent || '').replace(/\s+/g, ' ').replace(/\*/g, '').trim(); break; }
          p = p.parentElement;
        }
        out.push({ i, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30), section });
      });
    return out;
  }).catch(() => []);

  for (const b of buttons.slice(0, 8)) {
    const el = page.locator('[data-appshot-fa="' + b.i + '"]').first();
    if (!(await el.isVisible().catch(() => false))) continue;

    const before = await contentHeight(page);
    try {
      await safeClick(el, ctx.cfg, 'form action');
    } catch (e) {
      continue;                                  // deny-listed or not clickable
    }
    await page.waitForTimeout(1200);

    const name = (b.section || b.text).replace(/[^\w]+/g, '_').replace(/^_|_$/g, '');
    if (await dialogOpen(page)) {
      await waitForStable(page, ctx.cfg);
      await ctx.shoot(name + '_Popup', { note: 'Pop-up opened by "' + b.text + '" in ' + (b.section || 'the form'), inspect: true });
      await closeDialog(page);
      await page.waitForTimeout(400);
    } else {
      const after = await contentHeight(page);
      if (after > before + 40) {
        await waitForStable(page, ctx.cfg);
        await ctx.shoot(name + '_Row_Added', { note: 'A blank row added by "' + b.text + '" in ' + (b.section || 'the form') });
      }
    }
  }

  await page.evaluate(() => {
    document.querySelectorAll('[data-appshot-fa]').forEach((e) => e.removeAttribute('data-appshot-fa'));
  }).catch(() => {});
}

/**
 * Everything worth capturing once a form or detail screen is open: its
 * collapsible sections, and the pop-up windows behind its own Add controls.
 */
async function walkOpenedForm(page, ctx, prefix) {
  const sub = prefixed(ctx, prefix);
  await recipes.accordions(page, sub).catch((e) => log.warn('sections: ' + String(e.message).split('\n')[0]));
  await formActions(page, sub).catch((e) => log.warn('form actions: ' + String(e.message).split('\n')[0]));
}

/**
 * Explore the controls belonging to a view that has taken over the screen,
 * such as the 3D floor plan: its collapsed room list, its settings panel and
 * its area filters. Each is clicked and captured if it changed anything.
 *
 * Controls are re-found by position on every pass because opening a panel
 * reflows the ones after it.
 */
async function viewPanels(page, ctx) {
  const describe = () => page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((el) => {
        if (!vis(el)) return false;
        const r = el.getBoundingClientRect();
        if (r.top <= 90) return false;                        // the top strip is handled already
        if (r.x < 0 || r.x > window.innerWidth) return false;  // off-screen, inside a closed drawer
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return text.length <= 18;                              // an icon or a short filter label
      })
      .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { text: (el.textContent || '').trim().slice(0, 18), x: Math.round(r.x), y: Math.round(r.y) };
      });
  }).catch(() => []);

  const controls = await describe();
  if (!controls.length) return;
  log.step(controls.length + ' control(s) inside this view');

  for (let k = 0; k < Math.min(controls.length, ctx.cfg.interactions.maxViewPanels); k++) {
    const want = controls[k];
    const handle = await page.evaluateHandle((w) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from(document.querySelectorAll('button, [role="button"]')).find((el) => {
        if (!vis(el)) return false;
        const r = el.getBoundingClientRect();
        return Math.abs(r.x - w.x) < 6 && Math.abs(r.y - w.y) < 6;
      }) || null;
    }, want).catch(() => null);

    const el = handle && handle.asElement();
    if (!el) continue;

    const before = await page.evaluate(() => ({
      len: document.body.innerHTML.length,
      canvas: document.querySelectorAll('canvas').length,
    })).catch(() => ({ len: 0, canvas: 0 }));

    await el.click({ force: true }).catch(() => {});
    await page.waitForTimeout(ctx.cfg.interactions.hoverSettleMs);

    const after = await page.evaluate(() => document.body.innerHTML.length).catch(() => before.len);

    // A drawn view redraws its canvas without touching the markup — filtering
    // the floor plan to one area changes the picture and nothing else — so on
    // canvas views capture regardless of whether the DOM moved.
    const domChanged = Math.abs(after - before.len) >= 120;
    if (!domChanged && before.canvas === 0) continue;

    const name = want.text ? want.text.replace(/[^\w]+/g, '_') : 'Panel_' + (k + 1);
    await ctx.shoot(name, { note: 'A panel or filter of this view: ' + (want.text || 'icon control') });
  }
}

/**
 * Press the actions offered by a panel and capture what they ask for.
 *
 * The alarm panel lists a hundred and sixty alarms, each with its own
 * Acknowledge button that opens the same reason-and-signature window, so one
 * representative of each distinct label is pressed rather than every button.
 *
 * Opening the window records nothing — the entry is only made when it is
 * signed, and safeClick refuses "Confirm & Sign" — so the window is captured
 * and then cancelled.
 */
async function panelActions(page, ctx) {
  const actions = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    document.querySelectorAll('[data-appshot-pa]').forEach((e) => e.removeAttribute('data-appshot-pa'));
    const seen = new Set();
    const out = [];
    Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((el) => vis(el) && !el.closest('nav, aside, header'))
      .forEach((el) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 26) return;
        const key = text.toLowerCase();
        if (seen.has(key)) return;              // one example per distinct action
        seen.add(key);
        el.setAttribute('data-appshot-pa', String(out.length));
        out.push({ i: out.length, text });
      });
    return out;
  }).catch(() => []);

  for (const a of actions.slice(0, ctx.cfg.interactions.maxPanelActions)) {
    const el = page.locator('[data-appshot-pa="' + a.i + '"]').first();
    if (!(await el.isVisible().catch(() => false))) continue;

    try {
      await safeClick(el, ctx.cfg, 'panel action');
    } catch (e) {
      continue;                                  // a commit action; left alone
    }
    await page.waitForTimeout(1600);

    if (await dialogOpen(page)) {
      await waitForStable(page, ctx.cfg).catch(() => {});
      await ctx.shoot(a.text.replace(/[^\w]+/g, '_'), {
        note: 'Asked for by "' + a.text + '". Nothing is entered or signed.',
        inspect: true,
      });
      await closeDialog(page);
      await page.waitForTimeout(600);
    }
  }

  await page.evaluate(() => {
    document.querySelectorAll('[data-appshot-pa]').forEach((e) => e.removeAttribute('data-appshot-pa'));
  }).catch(() => {});
}

/** Return to the route's own URL — more reliable than goBack() on dirty forms. */
async function returnTo(page, url, cfg) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitForStable(page, cfg);
}

/** How tall the scrollable content currently is — the signal that a section opened. */
async function contentHeight(page) {
  return page.evaluate(() => {
    const inner = Array.from(document.querySelectorAll('body *')).find((el) => {
      const s = getComputedStyle(el);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20;
    });
    const doc = document.scrollingElement || document.documentElement;
    return Math.max(inner ? inner.scrollHeight : 0, doc.scrollHeight);
  }).catch(() => 0);
}

/** Find clickable section headers, whether or not they declare aria-expanded. */
async function findSectionHeaders(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 120 && r.height > 20 && r.height < 120
        && s.visibility !== 'hidden' && s.display !== 'none';
    };
    document.querySelectorAll('[data-appshot-sec]').forEach((e) => e.removeAttribute('data-appshot-sec'));

    const declared = Array.from(document.querySelectorAll('[aria-expanded]'))
      .filter((el) => vis(el) && el.tagName !== 'INPUT'
        && el.getAttribute('role') !== 'combobox'
        && !el.closest('table, thead, tbody, .MuiTablePagination-root, nav, header, aside'));

    const probed = declared.length ? [] : Array.from(
      document.querySelectorAll('div, button, [role="button"], summary, h3, h4')
    ).filter((el) => {
      if (!vis(el)) return false;
      if (el.closest('table, thead, tbody, .MuiTablePagination-root, nav, header, aside, [role="dialog"]')) return false;
      const s = getComputedStyle(el);
      const clickable = s.cursor === 'pointer' || el.tagName === 'BUTTON'
        || el.getAttribute('role') === 'button' || el.tagName === 'SUMMARY';
      if (!clickable) return false;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return text.length > 2 && text.length < 60;
    });

    const all = (declared.length ? declared : probed)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    // Drop headers nested inside another candidate — keep the outermost row.
    const kept = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));

    return kept.slice(0, 20).map((el, i) => {
      el.setAttribute('data-appshot-sec', String(i));
      return {
        i,
        text: (el.textContent || '').replace(/\s+/g, ' ').replace(/select all/i, '').trim().slice(0, 40),
        expanded: el.getAttribute('aria-expanded'),
      };
    });
  }).catch(() => []);
}

/**
 * Open caret-style sections that declare nothing in their markup.
 *
 * Candidates are clickable heading rows carrying an icon, outside the nav and
 * outside tables. Each is clicked and the content height measured: a real
 * accordion adds height, anything else does not and is clicked back so the
 * screen is left as it was found.
 */
async function expandByProbing(page, ctx) {
  const candidates = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 120 && r.height > 20 && r.height < 120
        && s.visibility !== 'hidden' && s.display !== 'none';
    };
    document.querySelectorAll('[data-appshot-probe]').forEach((e) => e.removeAttribute('data-appshot-probe'));
    const out = [];
    Array.from(document.querySelectorAll('div, button, [role="button"], summary, h3, h4, li'))
      .filter((el) => {
        if (!vis(el)) return false;
        if (el.closest('table, thead, tbody, .MuiTablePagination-root, nav, header, aside, [role="dialog"]')) return false;
        const s = getComputedStyle(el);
        const clickable = s.cursor === 'pointer' || el.tagName === 'BUTTON'
          || el.getAttribute('role') === 'button' || el.tagName === 'SUMMARY';
        if (!clickable) return false;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        // A section heading: some words, not a paragraph, not an empty icon.
        return text.length > 2 && text.length < 60;
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .slice(0, 20)
      .forEach((el, i) => {
        el.setAttribute('data-appshot-probe', String(i));
        out.push({ i, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) });
      });
    return out;
  }).catch(() => []);

  let opened = 0;
  for (const c of candidates) {
    const el = page.locator(`[data-appshot-probe="${c.i}"]`).first();
    if (!(await el.isVisible().catch(() => false))) continue;

    // Never probe a control that commits something.
    const deny = new RegExp(ctx.cfg.safety.denyClickText, 'i');
    if (deny.test(c.text)) continue;

    const before = await contentHeight(page);
    await el.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(350);
    const after = await contentHeight(page);

    if (after > before + 40) {
      opened += 1;
    } else {
      await el.click({ timeout: 3000 }).catch(() => {});   // not a section; put it back
      await page.waitForTimeout(150);
    }
  }

  await page.evaluate(() => {
    document.querySelectorAll('[data-appshot-probe]').forEach((e) => e.removeAttribute('data-appshot-probe'));
  }).catch(() => {});

  if (opened) log.step(`opened ${opened} collapsible section(s)`);
  return opened > 0;
}

// ---------------------------------------------------------------- recipes --

const recipes = {
  /** Every tab in a tablist, captured in its selected state. */
  async tabs(page, ctx) {
    const tabs = page.locator('[role="tab"]');
    const count = Math.min(await tabs.count().catch(() => 0), ctx.cfg.interactions.maxTabs);
    if (count < 2) return;
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i);
      const label = (await tab.innerText().catch(() => '')).replace(/\s+/g, ' ').trim() || `Tab${i + 1}`;
      const selected = await tab.getAttribute('aria-selected').catch(() => null);
      if (selected !== 'true') {
        await safeClick(tab, ctx.cfg, 'tab').catch(() => {});
        await waitForStable(page, ctx.cfg);
      }
      await ctx.shoot(`Tab_${label}`, { note: `Tab: ${label}` });
    }
  },

  /**
   * Expand every collapsed section, working down the page in the order a
   * reader would meet them, then capture the whole screen.
   *
   * Expanding one section can reveal another nested inside it, so this
   * re-scans between passes rather than taking a single snapshot of what was
   * collapsed at the start. Inputs, table controls and the nav are excluded —
   * an aria-expanded on those is a selection list or a menu, not a section.
   */
  async accordions(page, ctx) {
    const headers = await findSectionHeaders(page);
    if (!headers.length) {
      // Nothing declared itself; fall back to clicking and measuring.
      if (await expandByProbing(page, ctx)) {
        await waitForStable(page, ctx.cfg);
        await ctx.shoot('Sections_Expanded', { note: 'All collapsible sections opened' });
      }
      return;
    }

    // Click the left edge: these header rows often carry a "Select All"
    // checkbox on the right, and hitting that would change data.
    const clickHeader = async (i) => {
      const el = page.locator('[data-appshot-sec="' + i + '"]').first();
      if (!(await el.isVisible().catch(() => false))) return false;
      await el.click({ timeout: 4000, position: { x: 12, y: 12 } }).catch(() => {});
      await page.waitForTimeout(450);
      return true;
    };
    const clearMarks = () => page.evaluate(() => {
      document.querySelectorAll('[data-appshot-sec]').forEach((e) => e.removeAttribute('data-appshot-sec'));
    }).catch(() => {});

    if (headers.length === 1) {
      if (headers[0].expanded !== 'true') await clickHeader(0);
      await waitForStable(page, ctx.cfg);
      await ctx.shoot('Section_Open', { note: 'Section opened: ' + headers[0].text });
      await clearMarks();
      return;
    }

    // Work out whether sections stack up or replace each other. Some accordions
    // keep only one open at a time (CCMS Permission Assignment holds a single
    // expandedModule), and for those "expand everything and take one picture"
    // is impossible — each section needs its own capture.
    const base = await contentHeight(page);
    await clickHeader(0);
    const afterFirst = await contentHeight(page);
    await clickHeader(1);
    const afterSecond = await contentHeight(page);

    const grewOnce = afterFirst > base + 40;
    const exclusive = grewOnce && afterSecond <= afterFirst + 40;

    if (exclusive) {
      log.step(headers.length + ' sections, one open at a time — capturing each');
      for (const h of headers) {
        if (!(await clickHeader(h.i))) continue;
        await waitForStable(page, ctx.cfg);
        const label = h.text ? 'Section_' + h.text : 'Section_' + (h.i + 1);
        await ctx.shoot(label, { note: 'Section opened: ' + (h.text || h.i + 1) });
      }
      await clearMarks();
      return;
    }

    // Sections stack: open the rest and capture the whole screen once.
    for (const h of headers.slice(2)) await clickHeader(h.i);
    await clearMarks();
    if (!grewOnce && afterSecond <= base + 40) return;   // nothing actually opened
    await waitForStable(page, ctx.cfg);
    await ctx.shoot('Sections_Expanded', { note: 'All collapsible sections opened' });
  },

  /**
   * Some screens are really several screens behind one selector — the report
   * page is one selector with every report behind it, and a trend panel is a
   * chart with a "show me by..." selector. Step through every option and
   * capture each, re-applying the filter each time because each option brings
   * its own filter panel.
   *
   * Only view-switching selectors are swept: ones above the filter panel and
   * outside any table. A selection list inside the filter, or the rows-per-page
   * control, is not a different view of the screen.
   */
  async dropdownSweep(page, ctx) {
    const found = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      // Everything below the filter heading belongs to the filter, not the view.
      const panelTop = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,label,div,span'))
        .filter((e) => vis(e) && /^(filter panel|filters)$/i.test((e.textContent || '').trim()))
        .map((e) => e.getBoundingClientRect().top)
        .sort((a, b) => a - b)[0];
      const limit = panelTop !== undefined ? panelTop - 10 : 260;

      const combos = Array.from(document.querySelectorAll('[role="combobox"]')).filter((el) => {
        if (!vis(el)) return false;
        if (el.closest('table, .MuiTablePagination-root, nav, header, aside')) return false;
        return el.getBoundingClientRect().top < limit;
      });
      if (!combos.length) return null;
      combos[0].setAttribute('data-appshot-view', '1');
      return { current: (combos[0].value || combos[0].textContent || '').trim() };
    }).catch(() => null);

    if (!found) return;

    const selector = page.locator('[data-appshot-view]').first();
    await selector.click().catch(() => {});
    await page.waitForTimeout(700);
    const options = await page.locator('[role="option"]').allInnerTexts().catch(() => []);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);

    const names = options.map((o) => o.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (names.length < 2) return;
    log.step(`${names.length} view(s) behind this selector`);

    for (const name of names.slice(0, ctx.cfg.interactions.maxSweep)) {
      // The landing shot already covered whatever was selected on arrival.
      if (name === found.current) continue;
      try {
        const sel = page.locator('[role="combobox"]').first();
        await sel.click({ timeout: ctx.cfg.interactions.perActionTimeout });
        await page.waitForTimeout(500);
        const opt = page.locator('[role="option"]').filter({ hasText: name }).first();
        if (!(await opt.isVisible().catch(() => false))) { await page.keyboard.press('Escape').catch(() => {}); continue; }
        await opt.click();
        await waitForStable(page, ctx.cfg);

        // Each view has its own filter, so fill it before capturing.
        const filled = await autoFillFilters(page, ctx.cfg, { path: page.url() }).catch(() => null);
        if (filled) log.step(`autofill: ${filled}`);

        await ctx.shoot(name, { note: `Selected from the view list: ${name}`, inspect: true });
      } catch (e) {
        log.warn(`view "${name}" failed: ${String(e.message).split('\n')[0]}`);
      }
    }
  },

  /**
   * Charts that offer the same figures broken down different ways — "Trending
   * by Product / Manufacturing Line / Equipment / Material" — are one screen
   * with several answers. Select each in turn and capture it.
   */
  async toggleSweep(page, ctx) {
    const groups = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const byName = {};
      Array.from(document.querySelectorAll('input[type="radio"]')).forEach((el) => {
        // Radios inside a filter are criteria, not a view of the data.
        let p = el.parentElement; let inFilter = false;
        for (let i = 0; i < 8 && p; i++) {
          if (/filter panel|filters/i.test((p.getAttribute('aria-label') || '') + ' ' + (p.className || ''))) { inFilter = true; break; }
          p = p.parentElement;
        }
        if (inFilter) return;
        const name = el.name || '(unnamed)';
        (byName[name] = byName[name] || []).push({
          value: el.value,
          checked: el.checked,
          visible: vis(el) || vis(el.closest('label') || el),
        });
      });
      return Object.entries(byName)
        .filter(([, opts]) => opts.length >= 2 && opts.length <= 10 && opts.some((o) => o.visible))
        .map(([name, opts]) => ({ name, options: opts.map((o) => o.value), current: (opts.find((o) => o.checked) || {}).value }));
    }).catch(() => []);

    for (const group of groups) {
      for (const value of group.options.slice(0, ctx.cfg.interactions.maxSweep)) {
        if (value === group.current) continue;      // already captured on landing
        try {
          const radio = page.locator(`input[type="radio"][name="${group.name}"][value="${value}"]`).first();
          if (!(await radio.count().catch(() => 0))) continue;
          await radio.click({ timeout: ctx.cfg.interactions.perActionTimeout, force: true });
          await waitForStable(page, ctx.cfg);
          await ctx.shoot(`By_${value}`, { note: `Same screen shown by ${value}` });
        } catch (e) {
          log.warn(`toggle "${value}" failed: ${String(e.message).split('\n')[0]}`);
        }
      }
    }
  },

  /** Filter / advanced-search panel in its open state. */
  async filters(page, ctx) {
    const re = new RegExp(ctx.cfg.interactions.filterButtonText, 'i');
    const btn = page.getByRole('button', { name: re }).first();
    if (!(await btn.isVisible().catch(() => false))) return;
    await safeClick(btn, ctx.cfg, 'filter').catch(() => {});
    await page.waitForTimeout(600);
    await ctx.shoot('Filter_Open', { note: 'Filter panel expanded' });
    await closeDialog(page);
  },

  /** The Add / New / Create form — opened, captured, never submitted. */
  async openAdd(page, ctx) {
    const re = new RegExp(ctx.cfg.interactions.addButtonText, 'i');
    const findTarget = async () => {
      const btn = page.getByRole('button', { name: re }).first();
      const link = page.getByRole('link', { name: re }).first();
      if (await btn.isVisible().catch(() => false)) return btn;
      if (await link.isVisible().catch(() => false)) return link;
      return null;
    };

    const target = await findTarget();
    if (!target) return;
    const before = page.url();

    const pressAdd = async (el) => {
      try {
        await safeClick(el, ctx.cfg, 'add');
      } catch (e) {
        if (e instanceof BlockedClickError) { log.skip(e.message); return false; }
        throw e;
      }
      await page.waitForTimeout(900);
      await waitForStable(page, ctx.cfg);
      return true;
    };

    if (!(await pressAdd(target))) return;

    // Capture whatever the Add button produced, then tidy up after it.
    const captureForm = async (label, note) => {
      const modal = await dialogOpen(page);
      await ctx.shoot(label, { note: modal ? note + ' (pop-up window)' : note, inspect: true });
      if (!modal) await walkOpenedForm(page, ctx, label);
      if (modal) await closeDialog(page);
      if (page.url() !== before) await returnTo(page, before, ctx.cfg);
    };

    // One Add button can stand for several different forms: DMS offers "Full
    // Issuance Request" and "Partial Issuance Request", DVMS offers "Add New
    // Deviation" and "Reopen Deviation". Capturing only the first leaves the
    // other undocumented, so every choice on the menu is opened in turn.
    const menu = await readAddMenu(page);
    if (menu.length > 1) {
      log.step(`Add opens a menu of ${menu.length}: ${menu.map((m) => m.text).join(', ')}`);
      for (let i = 0; i < Math.min(menu.length, ctx.cfg.interactions.maxAddMenuItems); i++) {
        if (i > 0) {
          const again = await findTarget();
          if (!again || !(await pressAdd(again))) break;
          if (!(await readAddMenu(page)).length) break;
        }
        const opened = await clickAddMenuItem(page, ctx.cfg, i);
        if (!opened) continue;
        if (page.url() === before && !(await dialogOpen(page))) {
          log.skip(`"${menu[i].text}" opened nothing`);
          continue;
        }
        await captureForm(`Add_Form_${menu[i].text}`, `Add form — ${menu[i].text}`);
      }
      return;
    }

    // A single-entry menu still has to be clicked through to reach the form.
    if (page.url() === before && !(await dialogOpen(page)) && menu.length === 1) {
      if (!(await clickAddMenuItem(page, ctx.cfg, 0))) return;
      log.step(`chose "${menu[0].text}" from the Add menu`);
    }
    if (page.url() === before && !(await dialogOpen(page))) return;

    await captureForm('Add_Form', 'Add form');
  },

  /** A row's View action — the first row that offers one. */
  async rowView(page, ctx) {
    await rowAction(page, ctx, ctx.cfg.interactions.viewRowTitle, 'View_Record', 'Record detail view');
  },

  /** A row's Edit action — the first row that offers one, opened but never saved. */
  async rowEdit(page, ctx) {
    await rowAction(page, ctx, ctx.cfg.interactions.editRowTitle, 'Edit_Form', 'Edit form (not submitted)');
  },

  /**
   * The confirmation window behind a row's Deactivate / Delete icon — opened,
   * photographed, and dismissed.
   *
   * A manual has to show the reader what they will be asked for before a record
   * changes state, and in these systems that window is where the reason for
   * change and the electronic signature are collected. Nothing else reveals it.
   *
   * This is the one place a control on safeClick's deny list is pressed, so the
   * safety does not rest on that list. It rests on three things:
   *
   *   - every request that is not a GET is aborted at the network layer for the
   *     whole of the interaction, so nothing can reach the server even if the
   *     screen skipped its own confirmation step. The count of what was aborted
   *     is logged: a confirm dialog that is drawn client-side aborts nothing,
   *     and anything else is worth knowing about;
   *   - the window is closed through Cancel or Escape, never Confirm, and no
   *     password is ever typed;
   *   - the screen is reloaded afterwards, discarding whatever the client did
   *     to its own copy of the row.
   *
   * It is deliberately absent from the default recipe list. Naming it in an app
   * profile is the opt-in, and that decision belongs to whoever is running the
   * tool against a particular environment.
   */
  async rowDeactivate(page, ctx) {
    const before = page.url();
    let opened = false;
    const stopped = [];

    await withWritesBlocked(page, stopped, async () => {
      const found = await findRowAction(page, ctx, ctx.cfg.interactions.deactivateRowTitle,
                                        ctx.cfg.interactions.maxRowScan);
      if (!found) return;
      if (found.rowIndex > 0) log.step(`row ${found.rowIndex + 1} is the first that can be deactivated`);

      // Past safeClick on purpose. See the note above for what makes that safe.
      await found.target.click({ timeout: ctx.cfg.interactions.perActionTimeout }).catch(() => {});
      await page.waitForTimeout(1200);

      if (!(await dialogOpen(page))) {
        log.skip('the deactivate control opened no confirmation window; nothing captured');
        return;
      }
      opened = true;
      await ctx.shoot('Deactivate_Confirm', {
        note: 'Confirmation asked for before a record is deactivated (opened, not confirmed)',
        inspect: true,
      });
      await closeDialog(page);
    });

    if (stopped.length) {
      log.warn(`${stopped.length} request(s) blocked while the confirmation was open: `
               + stopped.slice(0, 3).join(', '));
    }
    if (opened) {
      // Throw away whatever the screen did to its own copy of the row.
      await returnTo(page, before, ctx.cfg);
    }
  },

  /**
   * Monitoring screens hide their detail behind the pointer: hovering a reading
   * draws its trend graph, hovering the small info mark shows the device's
   * battery and signal. None of that is reachable by clicking, so nothing was
   * ever captured from it.
   *
   * One example of each kind is taken, not one per tile — forty identical
   * temperature graphs teach the reader nothing.
   */
  async hoverSweep(page, ctx) {
    const targets = await page.evaluate(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.top > 60 && s.visibility !== 'hidden';
      };
      document.querySelectorAll('[data-appshot-hov]').forEach((e) => e.removeAttribute('data-appshot-hov'));

      const picked = [];
      const seenKind = new Set();
      const consider = (el, kind) => {
        if (seenKind.has(kind)) return;
        seenKind.add(kind);
        el.setAttribute('data-appshot-hov', String(picked.length));
        picked.push({ i: picked.length, kind });
      };

      // Readings: a pointer-cursor cell whose text is a number plus a unit.
      Array.from(document.querySelectorAll('div, span, td')).filter(vis).forEach((el) => {
        if (el.children.length > 1) return;
        const s = getComputedStyle(el);
        if (s.cursor !== 'pointer') return;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const m = text.match(/^-?[\d.]+\s*(°C|°F|%|ppm|Pa|RH|mbar)$/i);
        if (!m) return;
        const unit = m[1].toLowerCase();
        // Name the capture after what is being measured, not its symbol.
        const kind = /c|f/.test(unit.replace('°', '')) && unit.includes('°') ? 'Temperature'
          : (unit === '%' || unit === 'rh') ? 'Humidity'
          : unit === 'ppm' ? 'Concentration'
          : (unit === 'pa' || unit === 'mbar') ? 'Pressure'
          : 'Reading';
        consider(el, kind);
      });

      // The small marks on each tile — info, battery, signal.
      Array.from(document.querySelectorAll('svg')).filter(vis).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 26 || r.height > 26) return;
        consider(el, 'Device_Info');
      });

      return picked;
    }).catch(() => []);

    if (!targets.length) return;

    for (const t of targets.slice(0, ctx.cfg.interactions.maxHover)) {
      const el = page.locator('[data-appshot-hov="' + t.i + '"]').first();
      if (!(await el.isVisible().catch(() => false))) continue;

      const before = await page.evaluate(() => ({
        len: document.body.innerHTML.length,
        canvas: document.querySelectorAll('canvas').length,
      })).catch(() => ({ len: 0, canvas: 0 }));

      await el.hover({ force: true }).catch(() => {});
      await page.waitForTimeout(ctx.cfg.interactions.hoverSettleMs);

      const after = await page.evaluate(() => ({
        len: document.body.innerHTML.length,
        canvas: document.querySelectorAll('canvas').length,
      })).catch(() => before);

      // Only capture when the hover actually revealed something.
      if (after.canvas > before.canvas || after.len > before.len + 200) {
        await ctx.shoot('Hover_' + t.kind, { note: 'Shown by resting the pointer on a ' + t.kind.replace(/_/g, ' ') });
      }
      await page.mouse.move(2, 2).catch(() => {});
      await page.waitForTimeout(600);
    }

    await page.evaluate(() => {
      document.querySelectorAll('[data-appshot-hov]').forEach((e) => e.removeAttribute('data-appshot-hov'));
    }).catch(() => {});
  },

  /**
   * The icon strip along the top of a monitoring screen — mute, map, refresh,
   * play, alarms. Each opens a panel or swaps the whole view (the map icon
   * draws a 3D plan of the facility), and none carries a text label.
   *
   * The screen is reloaded between icons: these toggles change the view in
   * place rather than navigating, so there is no reliable way back.
   */
  async iconBar(page, ctx) {
    const routeUrl = page.url();
    const icons = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter((el) => {
          if (!vis(el)) return false;
          const r = el.getBoundingClientRect();
          if (r.top > 90) return false;                       // top strip only
          if (r.width > 70 || r.height > 70) return false;     // icon-sized
          if ((el.textContent || '').trim().length > 2) return false;
          // The leftmost control is "back"; following it leaves the screen.
          return r.x > window.innerWidth / 2;
        })
        .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
        .map((el, i) => {
          const r = el.getBoundingClientRect();
          return { i, x: Math.round(r.x), hint: el.getAttribute('title') || el.getAttribute('aria-label') || '' };
        });
    }).catch(() => []);

    if (!icons.length) return;
    log.step(icons.length + ' icon control(s) in the top strip');

    for (let k = 0; k < Math.min(icons.length, 8); k++) {
      // Re-find by position each time: the page is reloaded between icons.
      const el = page.locator('button, [role="button"]').filter({ hasNotText: /\S\S/ }).nth(0);
      const target = await page.evaluateHandle((wanted) => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const list = Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter((e) => {
            if (!vis(e)) return false;
            const r = e.getBoundingClientRect();
            return r.top <= 90 && r.width <= 70 && r.height <= 70
              && (e.textContent || '').trim().length <= 2 && r.x > window.innerWidth / 2;
          })
          .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
        return list[wanted] || null;
      }, k).catch(() => null);

      const handle = target && target.asElement();
      if (!handle) continue;

      const before = await page.evaluate(() => document.body.innerHTML.length).catch(() => 0);
      await handle.click({ force: true }).catch(() => {});
      // A 3D plan takes noticeably longer to draw than a panel.
      await page.waitForTimeout(ctx.cfg.interactions.iconSettleMs);
      await waitForStable(page, ctx.cfg).catch(() => {});

      const after = await page.evaluate(() => document.body.innerHTML.length).catch(() => before);
      const changed = Math.abs(after - before) > 400 || (await dialogOpen(page));

      if (changed) {
        const name = icons[k].hint
          ? icons[k].hint.replace(/[^\w]+/g, '_')
          : 'Toolbar_' + (k + 1);
        await ctx.shoot(name, { note: 'Opened by the icon at position ' + (k + 1) + ' in the top strip', inspect: true });

        // A view that replaced the screen (the floor plan does) has controls
        // of its own — a room list, a settings panel, area filters. Capture
        // those too, under the view's name.
        const replaced = before > 0 && after < before * 0.6;
        if (replaced) {
          await viewPanels(page, prefixed(ctx, name));
        } else if (after > before * 1.15) {
          // A panel that opened over the screen (the alarm list) offers
          // actions of its own; capture what each one asks for.
          await panelActions(page, prefixed(ctx, name)).catch((e) =>
            log.warn('panel actions: ' + String(e.message).split('\n')[0]));
        }
      }

      // These are in-place toggles, so reload rather than trying to undo them.
      await page.goto(routeUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForStable(page, ctx.cfg).catch(() => {});
      await page.waitForTimeout(800);
    }
  },

  /**
   * Approved reports are read as documents, not as rows. The print control on
   * each row fetches a PDF and renders it in an overlay viewer, so the finished
   * document — letterhead, generated-by and approved-by signatures and all — is
   * only visible after that has happened.
   *
   * Generating it takes several seconds, so this waits for the viewer to appear
   * rather than guessing a delay, then closes it again.
   */
  async printPreview(page, ctx) {
    const triggers = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      document.querySelectorAll('[data-appshot-print]').forEach((e) => e.removeAttribute('data-appshot-print'));
      const rows = Array.from(document.querySelectorAll('tbody tr')).slice(0, 1);
      const out = [];
      rows.forEach((row) => {
        Array.from(row.querySelectorAll('button, a, [role="button"]')).filter(vis).forEach((el) => {
          const hint = ((el.className || '').toString() + ' ' + (el.getAttribute('title') || '')
            + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
          if (!/print|pdf|document/.test(hint)) return;
          el.setAttribute('data-appshot-print', String(out.length));
          out.push({ i: out.length });
        });
      });
      return out;
    }).catch(() => []);

    if (!triggers.length) return;

    const el = page.locator('[data-appshot-print="0"]').first();
    if (!(await el.isVisible().catch(() => false))) return;

    const canvasesBefore = await page.locator('canvas').count().catch(() => 0);
    await el.click({ force: true }).catch(() => {});

    // Wait for the document to finish rendering instead of guessing.
    const deadline = Date.now() + ctx.cfg.interactions.printTimeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(700);
      const now = await page.locator('canvas').count().catch(() => 0);
      if (now > canvasesBefore) { ready = true; break; }
    }
    if (!ready) { log.warn('print preview did not open in time'); return; }

    await page.waitForTimeout(1800);           // let the first page paint fully
    await ctx.shoot('Printed_Document', { note: 'The approved report as it prints, opened from the print control' });

    // Close the viewer so the screen is left as it was found.
    const close = page.locator('button', { hasText: /^\s*close\s*$/i }).first();
    if (await close.isVisible().catch(() => false)) {
      await close.click({ force: true }).catch(() => {});
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      document.querySelectorAll('[data-appshot-print]').forEach((e) => e.removeAttribute('data-appshot-print'));
    }).catch(() => {});
  },

  /** Second page of a paginated grid. */
  async paginate(page, ctx) {
    const next = page.getByRole('button', { name: /next page|next/i }).first();
    if (!(await next.isVisible().catch(() => false))) return;
    if (!(await next.isEnabled().catch(() => false))) return;
    await safeClick(next, ctx.cfg, 'pagination').catch(() => {});
    await waitForStable(page, ctx.cfg);
    await ctx.shoot('Grid_Page2', { note: 'Grid - second page' });
  },
};

/**
 * Is this control actually usable?
 *
 * These grids render every action on every row and disable the ones the row's
 * status does not allow — a document already approved keeps a greyed Edit
 * pencil. Row 1 is therefore the wrong row to document from more often than
 * not. Tailwind writes those states as `disabled:opacity-50`, a class that is
 * present whether or not the control is disabled, so the class string tells you
 * nothing; the computed style and the disabled property do.
 */
async function actionable(locator) {
  if (!(await locator.isEnabled().catch(() => false))) return false;
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    if (s.pointerEvents === 'none') return false;
    if (parseFloat(s.opacity || '1') < 0.7) return false;
    return el.getAttribute('aria-disabled') !== 'true';
  }).catch(() => false);
}

/**
 * Find a row that offers the wanted action in a usable state.
 *
 * Row actions here are icon-only with no title and no aria-label — the only
 * thing identifying them is a class like "icon-btn edit" — so the pattern is
 * matched against class as well as the accessible attributes.
 */
async function findRowAction(page, ctx, titlePattern, maxRows) {
  const re = new RegExp(titlePattern, 'i');
  const rows = page.locator('tbody tr');
  const total = Math.min(await rows.count().catch(() => 0), maxRows || 10);
  let seenDisabled = false;

  for (let r = 0; r < total; r++) {
    const row = rows.nth(r);
    if (!(await row.isVisible().catch(() => false))) continue;
    const candidates = row.locator('button, a, [role="button"]');
    const n = await candidates.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const c = candidates.nth(i);
      const title = (await c.getAttribute('title').catch(() => null)) || '';
      const aria = (await c.getAttribute('aria-label').catch(() => null)) || '';
      const cls = (await c.getAttribute('class').catch(() => null)) || '';
      if (!(re.test(title) || re.test(aria) || re.test(cls))) continue;
      if (await actionable(c)) return { target: c, rowIndex: r };
      seenDisabled = true;
    }
  }
  if (seenDisabled) log.skip(`every ${titlePattern} control in the first ${total} row(s) is disabled on this screen`);
  return null;
}

async function rowAction(page, ctx, titlePattern, slug, note) {
  const found = await findRowAction(page, ctx, titlePattern, ctx.cfg.interactions.maxRowScan);
  if (!found) return;
  if (found.rowIndex > 0) log.step(`row ${found.rowIndex + 1} is the first with ${slug} available`);

  const before = page.url();
  try {
    await safeClick(found.target, ctx.cfg, slug);
  } catch (e) {
    if (e instanceof BlockedClickError) { log.skip(e.message); return; }
    return;
  }
  await page.waitForTimeout(900);
  await waitForStable(page, ctx.cfg);

  const navigated = page.url() !== before;
  const modal = await dialogOpen(page);
  if (!navigated && !modal) return;

  await ctx.shoot(slug, { note, inspect: true });
  // A detail or edit screen has the same collapsed sections and its own Add
  // controls as the blank form, so walk it the same way.
  if (!modal) await walkOpenedForm(page, ctx, slug);
  if (modal) await closeDialog(page);
  if (navigated) await returnTo(page, before, ctx.cfg);
}

/**
 * Run fn with every request that is not a plain read aborted at the network
 * layer, recording what was stopped.
 *
 * page.route() takes precedence over the context-level guard, so for the
 * duration of fn the run is strictly read-only whatever gets clicked. These
 * APIs do use POST for list and search reads, so blocking POST too can leave a
 * panel unfilled — that is the right way round for the few seconds this is
 * armed, and `stopped` says whether it actually cost anything.
 */
async function withWritesBlocked(page, stopped, fn) {
  const handler = (route) => {
    const req = route.request();
    const m = req.method().toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return route.continue();
    stopped.push(`${m} ${req.url().replace(/^https?:\/\/[^/]+/, '')}`);
    return route.abort();
  };
  await page.route('**/*', handler);
  try {
    return await fn();
  } finally {
    await page.unroute('**/*', handler).catch(() => {});
  }
}

// ------------------------------------------------------------------ setup --


/**
 * Date tokens usable in setup step values. Many screens default to a narrow
 * window (CCMS's dashboard defaults to first-of-month..today, which on the 1st
 * of a month is a single day and renders every chart empty), so a profile needs
 * a way to widen the range before capturing.
 */
function resolveTokens(value) {
  if (typeof value !== 'string') return value;
  const iso = (d) => d.toISOString().split('T')[0];
  return value
    .replace(/\{\{today\}\}/g, () => iso(new Date()))
    // Some screens tie a date range to a separate Year field and reject a
    // start date outside it, so a relative offset is not always usable.
    .replace(/\{\{startOfYear\}\}/g, () => `${new Date().getFullYear()}-01-01`)
    .replace(/\{\{endOfYear\}\}/g, () => `${new Date().getFullYear()}-12-31`)
    .replace(/\{\{daysAgo:(\d+)\}\}/g, (m, n) => {
      const d = new Date();
      d.setDate(d.getDate() - Number(n));
      return iso(d);
    })
    .replace(/\{\{monthsAgo:(\d+)\}\}/g, (m, n) => {
      const d = new Date();
      d.setMonth(d.getMonth() - Number(n));
      return iso(d);
    });
}

/**
 * Type an ISO date (YYYY-MM-DD) into a segmented picker as raw digits, in the
 * order the field displays them. `format` is the field's segment order —
 * 'DMY' (01/09/2025), 'MDY' (09/01/2025) or 'YMD'.
 */
async function typeSegmentedDate(page, locator, isoValue, format) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoValue || '').trim());
  if (!m) throw new Error(`fillDate expects YYYY-MM-DD, got "${isoValue}"`);
  const [, y, mo, d] = m;
  const order = { DMY: d + mo + y, MDY: mo + d + y, YMD: y + mo + d };
  const digits = order[String(format).toUpperCase()] || order.DMY;

  await locator.click();
  await page.keyboard.type(digits, { delay: 60 });
  await page.waitForTimeout(300);
}

function stepLocator(page, step) {
  if (step.selector) {
    const loc = page.locator(step.selector);
    return step.nth === undefined ? loc.first() : loc.nth(step.nth);
  }
  if (step.role && step.name) {
    return page.getByRole(step.role, { name: new RegExp(step.name, 'i') }).first();
  }
  if (step.text) {
    return page.getByText(new RegExp(step.text, 'i')).first();
  }
  if (step.placeholder) return page.getByPlaceholder(step.placeholder).first();
  throw new Error('setup step needs one of: selector / role+name / text / placeholder');
}

/**
 * Put a screen into the state worth documenting before capturing it —
 * widen a date filter, choose a tab, select a record. Read-only rules still
 * apply: setup clicks go through safeClick().
 */
async function runSetup(page, ctx, steps) {
  for (const step of steps || []) {
    try {
      if (step.action === 'wait') { await page.waitForTimeout(Number(step.value) || 500); continue; }
      if (step.action === 'waitStable') { await waitForStable(page, ctx.cfg); continue; }

      const loc = stepLocator(page, step);
      await loc.waitFor({ state: 'visible', timeout: step.timeout || ctx.cfg.interactions.perActionTimeout });

      if (step.action === 'click') {
        await safeClick(loc, ctx.cfg, 'setup');
      } else if (step.action === 'fill') {
        await loc.fill(resolveTokens(step.value) || '');
        // Native date/select inputs driven by React need an explicit event.
        await loc.dispatchEvent('change').catch(() => {});
      } else if (step.action === 'fillDate') {
        // MUI X segmented date fields are not real inputs — the visible field
        // is a row of role="spinbutton" sections and fill() silently no-ops on
        // them. Focus the first section and type digits; MUI advances through
        // day -> month -> year on its own.
        await typeSegmentedDate(page, loc, resolveTokens(step.value), step.format || 'DMY');
      } else if (step.action === 'pickOption') {
        // Choose a named entry from a selection list. It matches on the label
        // and fails loudly if that label is not offered — never falling back to
        // "whatever was first", which would quietly document the wrong record.
        await loc.click();
        await page.waitForTimeout(400);
        if (step.type) await loc.pressSequentially(step.type, { delay: 80 });
        await page.waitForTimeout(step.type ? 900 : 400);

        // MUI uses role="option"; react-select renders its own option class.
        const optionList = page.locator('[role="option"], [class*="-option"]');
        if (step.option) {
          const option = optionList.filter({ hasText: new RegExp(step.option, 'i') }).first();
          if (!(await option.isVisible().catch(() => false))) {
            const offered = await optionList.allInnerTexts().catch(() => []);
            throw new Error(
              `no option matching "${step.option}" — offered: ${offered.slice(0, 8).join(', ') || '(none)'}`
            );
          }
          await option.click({ force: true });
        } else {
          // No name given: take a positional choice, for lists whose entries
          // differ per environment and where any record will do.
          const idx = Number(step.index || 0);
          const option = optionList.nth(idx);
          if (!(await option.isVisible().catch(() => false))) {
            throw new Error(`no option at position ${idx}`);
          }
          await option.click({ force: true });
        }
      } else if (step.action === 'select') {
        await loc.selectOption(resolveTokens(step.value));
      } else {
        log.warn(`unknown setup action "${step.action}"`);
        continue;
      }
      await page.waitForTimeout(step.settle || 400);
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).split('\n')[0];
      log.warn(`setup step (${step.action}) failed: ${msg}`);
    }
  }
  await waitForStable(page, ctx.cfg);
}

/** Run the configured recipe list for one route; failures never abort the run. */
async function runRecipes(page, ctx) {
  const names = ctx.recipes || ctx.cfg.interactions.recipes;
  for (const name of names) {
    const fn = recipes[name];
    if (!fn) { log.warn(`unknown recipe "${name}"`); continue; }
    try {
      await fn(page, ctx);
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).split('\n')[0];
      log.warn(`recipe "${name}" failed: ${msg}`);
    }
  }
}

module.exports = { runRecipes, runSetup, recipes, safeClick, closeDialog, BlockedClickError };
