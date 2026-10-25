/**
 * capture.js — uniform, viewport-sized screenshots.
 *
 * Every image this module produces is exactly the configured viewport size.
 * A screen taller than the viewport becomes an ordered series of overlapping
 * slices (_Top / _Middle / _Bottom) rather than one tall image.
 *
 * Why slices and not fullPage:
 *   1. Uniform dimensions. A folder of 1440x900 images can be flipped through,
 *      diffed and dropped into a document; a folder mixing 900px and 5900px
 *      images cannot.
 *   2. It does not touch the layout. The previous fullPage approach relaxed
 *      the app-shell scroll containers so the document would grow tall — but
 *      resizing those containers makes Chart.js re-render its canvases, and
 *      the capture landed mid-redraw with every chart blank. Scrolling changes
 *      nothing about the layout, so charts, grids and virtualised rows are
 *      captured exactly as a user sees them.
 *
 * The hard part is that admin SPAs are `height:100vh; overflow:hidden` with the
 * real content in a nested scroll container, so window.scrollTo does nothing.
 * findScroller() locates the element that actually scrolls and drives that.
 */
const fs = require('fs');
const path = require('path');

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
`;

const HIDE_SCROLLBAR_CSS = `
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
  * { scrollbar-width: none !important; }
`;

const SCROLLER_ATTR = 'data-appshot-scroller';

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/**
 * Find the element that actually scrolls this screen.
 * Returns { mode: 'window'|'element'|'none', total, view }.
 */
async function findScroller(page) {
  return page.evaluate((attr) => {
    document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));

    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };

    // A pop-up window is the subject when one is open. Without this the slices
    // walk the whole screen behind it — acknowledging an alarm produced twelve
    // images of the alarm list with a small dialog floating over the first.
    // Several overlays can be open at once — acknowledging an alarm puts a
    // small signature window on top of the alarm drawer, and both are fixed
    // and raised. The subject is the topmost one, so rank by stacking order
    // and, where that ties, take the one added last.
    const all = Array.from(document.querySelectorAll('[role="dialog"], div'));
    const overlays = [];
    all.forEach((el, order) => {
      if (!isVisible(el)) return;
      const s = getComputedStyle(el);
      const z = parseInt(s.zIndex || '0', 10) || 0;
      const isDialog = el.getAttribute('role') === 'dialog';
      if (!isDialog && (s.position !== 'fixed' || z < 10)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 300 || r.height < 150) return;
      if ((el.textContent || '').trim().length < 10) return;
      // Ignore a wrapper that merely contains another candidate.
      overlays.push({ el, z, order, area: r.width * r.height });
    });
    const outermostOnly = overlays.filter((o) => !overlays.some((p) => p !== o && o.el.contains(p.el)));
    const ranked = (outermostOnly.length ? outermostOnly : overlays)
      .sort((a, b) => (b.z - a.z) || (b.order - a.order));
    const overlay = ranked.length ? ranked[0].el : null;

    if (overlay) {
      const inner = Array.from(overlay.querySelectorAll('*')).find((el) => {
        const s = getComputedStyle(el);
        const oy = s.overflowY;
        return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 20
          && isVisible(el);
      });
      if (inner) {
        inner.setAttribute(attr, '1');
        return { mode: 'element', total: inner.scrollHeight, view: inner.clientHeight };
      }
      // The window fits as it is: one image of the screen with it open.
      return { mode: 'none', total: window.innerHeight, view: window.innerHeight };
    }

    const candidates = Array.from(document.querySelectorAll('body *')).filter((el) => {
      const s = getComputedStyle(el);
      const oy = s.overflowY;
      if (oy !== 'auto' && oy !== 'scroll') return false;
      if (el.scrollHeight <= el.clientHeight + 20) return false;
      const r = el.getBoundingClientRect();
      return r.width > 200 && r.height > 200;      // ignore small widgets
    });

    // Largest on-screen scroller wins — that is the content pane, not a
    // scrollable dropdown or a mini list inside a card.
    let best = null;
    let bestArea = 0;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = el; bestArea = area; }
    }

    const doc = document.scrollingElement || document.documentElement;
    const docScrolls = doc.scrollHeight > window.innerHeight + 20;

    if (best) {
      best.setAttribute(attr, '1');
      return { mode: 'element', total: best.scrollHeight, view: best.clientHeight };
    }
    if (docScrolls) {
      return { mode: 'window', total: doc.scrollHeight, view: window.innerHeight };
    }
    return { mode: 'none', total: window.innerHeight, view: window.innerHeight };
  }, SCROLLER_ATTR).catch(() => ({ mode: 'none', total: 0, view: 0 }));
}

async function scrollToOffset(page, mode, y) {
  await page.evaluate(({ m, top, attr }) => {
    if (m === 'element') {
      const el = document.querySelector(`[${attr}]`);
      if (el) el.scrollTop = top;
    } else {
      window.scrollTo(0, top);
    }
  }, { m: mode, top: y, attr: SCROLLER_ATTR }).catch(() => {});
}

async function clearScrollerMark(page) {
  await page.evaluate((attr) => {
    document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
  }, SCROLLER_ATTR).catch(() => {});
}

/** Walk the scroller top-to-bottom once, to trigger lazy/virtualised content. */
async function preScroll(page, cfg, scroller) {
  if (!cfg.capture.preScroll || scroller.mode === 'none') return;
  const step = Math.max(200, Math.floor(scroller.view * cfg.capture.preScrollStepRatio));
  for (let y = 0; y < scroller.total; y += step) {
    await scrollToOffset(page, scroller.mode, y);
    await page.waitForTimeout(cfg.capture.preScrollWaitMs);
  }
  await scrollToOffset(page, scroller.mode, 0);
  await page.waitForTimeout(cfg.capture.preScrollWaitMs);
}

async function applyCaptureStyles(page, cfg) {
  const handles = [];
  if (cfg.capture.freezeAnimations) {
    handles.push(await page.addStyleTag({ content: FREEZE_CSS }).catch(() => null));
  }
  if (cfg.capture.hideScrollbars) {
    handles.push(await page.addStyleTag({ content: HIDE_SCROLLBAR_CSS }).catch(() => null));
  }
  return handles.filter(Boolean);
}

async function removeCaptureStyles(handles) {
  for (const h of handles) {
    await h.evaluate((node) => node.remove()).catch(() => {});
  }
}

/**
 * Charts render asynchronously into <canvas> and animate on first paint.
 * If any canvas is present, give it extra time before shooting — a blank
 * chart is worse than a slow run.
 */
async function waitForCanvases(page, cfg) {
  const n = await page.locator('canvas').count().catch(() => 0);
  if (n > 0) await page.waitForTimeout(cfg.capture.chartSettleMs);
  return n;
}

/**
 * Positional suffixes matching the existing manual convention:
 *   1 slice  -> ''                       (01_Grid.png)
 *   2 slices -> _Top, _Bottom
 *   3 slices -> _Top, _Middle, _Bottom
 *   4+       -> _Top, _Middle_2 .. _Middle_(n-1), _Bottom
 */
function sliceSuffixes(count) {
  if (count <= 1) return [''];
  if (count === 2) return ['_Top', '_Bottom'];
  if (count === 3) return ['_Top', '_Middle', '_Bottom'];
  const out = ['_Top'];
  for (let i = 2; i <= count - 1; i++) out.push(`_Middle_${i}`);
  out.push('_Bottom');
  return out;
}

/**
 * Capture the current screen as one or more uniform viewport images.
 *
 * `makePath(suffix)` builds the destination for each slice, so the caller
 * controls numbering and naming.
 *
 * Returns { files, slices, contentHeight, width, height }.
 */
async function captureScreen(page, makePath, cfg) {
  const styleHandles = await applyCaptureStyles(page, cfg);
  try {
    let scroller = await findScroller(page);
    await preScroll(page, cfg, scroller);

    // Lazy content may have changed the height — re-measure after pre-scroll.
    scroller = await findScroller(page);
    await waitForCanvases(page, cfg);
    await page.waitForTimeout(cfg.capture.settleMs);

    const view = scroller.view || cfg.browser.viewport.height;
    const total = Math.max(scroller.total || view, view);
    const overlap = cfg.capture.sliceOverlap;
    const step = Math.max(120, view - overlap);

    // A screen only a little taller than the viewport would otherwise produce a
    // second slice that is almost a duplicate of the first, so require the
    // overflow to be worth a whole extra image.
    const overflow = total - view;
    let count = overflow < cfg.capture.minSliceGain ? 1 : Math.ceil(overflow / step) + 1;
    count = Math.min(count, cfg.capture.maxSlices);

    const suffixes = sliceSuffixes(count);
    const files = [];

    for (let i = 0; i < count; i++) {
      // Clamp the last slice to the bottom so it aligns with the page end
      // instead of running past it into blank space.
      const y = count === 1 ? 0 : Math.min(i * step, total - view);
      if (count > 1) {
        await scrollToOffset(page, scroller.mode, y);
        await page.waitForTimeout(cfg.capture.sliceSettleMs);
      }

      const file = makePath(suffixes[i]);
      ensureDir(file);
      const opts = { path: file, fullPage: false };
      if (cfg.capture.type === 'jpeg') { opts.type = 'jpeg'; opts.quality = cfg.capture.quality || 85; }
      if ((cfg.capture.maskSelectors || []).length) {
        opts.mask = cfg.capture.maskSelectors.map((s) => page.locator(s));
      }
      await page.screenshot(opts);
      files.push(file);
    }

    if (count > 1) await scrollToOffset(page, scroller.mode, 0);
    await clearScrollerMark(page);

    return {
      files,
      slices: count,
      contentHeight: total,
      width: cfg.browser.viewport.width,
      height: cfg.browser.viewport.height,
    };
  } finally {
    await removeCaptureStyles(styleHandles);
  }
}

/** Capture a single element (a modal, a chart) rather than the screen. */
async function captureElement(locator, filePath, cfg) {
  ensureDir(filePath);
  const opts = {};
  if (cfg.capture.type === 'jpeg') { opts.type = 'jpeg'; opts.quality = cfg.capture.quality || 85; }
  await locator.screenshot(Object.assign({ path: filePath }, opts));
  return { files: [filePath], slices: 1 };
}

module.exports = { captureScreen, captureElement, findScroller, sliceSuffixes };
