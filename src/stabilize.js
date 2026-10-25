/**
 * stabilize.js — wait until a page has stopped moving before capturing it.
 *
 * A screenshot taken one frame too early is the single biggest source of junk
 * in an automated capture run: half-rendered grids, spinner overlays, charts
 * mid-animation, fonts still swapping. Every wait here is best-effort and
 * time-boxed, so a page that never reaches idle still gets captured.
 */

async function waitForNetworkIdle(page, timeout) {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}

async function waitForSpinnersGone(page, selectors, timeout) {
  if (!selectors || !selectors.length) return;
  const joined = selectors.join(', ');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const busy = await page
      .evaluate((sel) => {
        const nodes = Array.from(document.querySelectorAll(sel));
        return nodes.some((n) => {
          const r = n.getBoundingClientRect();
          const s = getComputedStyle(n);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        });
      }, joined)
      .catch(() => false);
    if (!busy) return;
    await page.waitForTimeout(200);
  }
}

async function waitForFonts(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)).catch(() => {});
}

async function waitForImages(page) {
  await page
    .evaluate(async () => {
      const imgs = Array.from(document.images).filter((i) => !i.complete);
      await Promise.all(
        imgs.map((i) => new Promise((res) => {
          i.addEventListener('load', res, { once: true });
          i.addEventListener('error', res, { once: true });
          setTimeout(res, 3000);
        }))
      );
    })
    .catch(() => {});
}

async function waitForStable(page, cfg) {
  const s = cfg.stabilize;
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await waitForNetworkIdle(page, s.networkIdleTimeout);
  await waitForSpinnersGone(page, s.spinnerSelectors, s.spinnerTimeout);
  if (s.waitFonts) await waitForFonts(page);
  await waitForImages(page);
  await page.waitForTimeout(cfg.capture.settleMs);
}

module.exports = { waitForStable, waitForSpinnersGone, waitForNetworkIdle };
