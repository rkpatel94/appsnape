/**
 * report.js — turn a capture run into deliverables.
 *
 *   PageInventory.md  the QA-facing document: every screen, its screenshot,
 *                     its fields, its actions, its grid columns.
 *   gallery.html      a self-contained browsable index of the run.
 *   manifest.json     the machine-readable record, for diffing runs.
 */
const fs = require('fs');
const path = require('path');

function pad2(n) { return String(n).padStart(2, '0'); }

function esc(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function htmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relFiles(capture, outputDir) {
  return (capture.files || []).map((f) => path.relative(outputDir, f).split(path.sep).join('/'));
}

// ------------------------------------------------------------ PageInventory

function buildPageInventory(manifest, outputDir) {
  const a = manifest.app;
  const totalShots = manifest.stats.captures;
  const L = [];

  L.push(`# ${a.displayName} — Comprehensive Page Inventory`);
  L.push('');
  L.push(`**Application:** ${a.displayName}`);
  L.push(`**Base URL:** ${a.baseUrl}`);
  if (a.user) L.push(`**Login User:** ${a.user}`);
  L.push(`**Documentation Date:** ${manifest.startedAt.slice(0, 10)}`);
  L.push(`**Total Screenshots:** ${totalShots}`);
  L.push(`**Total Modules Documented:** ${manifest.modules.length}`);
  const vp = a.viewport || {};
  if (vp.width) L.push(`**Screenshot Size:** ${vp.width} x ${vp.height} px (uniform; taller screens are split into _Top / _Middle / _Bottom slices)`);
  L.push(`**Captured By:** AppShot v${manifest.toolVersion} (automated, read-only)`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push('| # | Module | Screens | Screenshots | Status |');
  L.push('|---|---|---|---|---|');
  manifest.modules.forEach((m, i) => {
    // Count images, not captures — a sliced screen is several files, and the
    // total in the header is counted that way too.
    const shots = m.routes.reduce(
      (n, r) => n + r.captures.reduce((k, c) => k + c.files.length, 0), 0);
    const failed = m.routes.filter((r) => r.status === 'failed').length;
    const status = failed ? `${failed} failed` : 'OK';
    L.push(`| ${i + 1} | ${esc(m.name)} | ${m.routes.length} | ${shots} | ${status} |`);
  });
  L.push('');
  L.push('---');
  L.push('');

  manifest.modules.forEach((m, mi) => {
    L.push(`## ${pad2(mi + 1)} — ${m.name}`);
    L.push('');

    m.routes.forEach((r, ri) => {
      L.push(`### ${pad2(mi + 1)}.${ri + 1} — ${r.name}`);
      L.push('');
      L.push(`**URL:** \`${r.path}\``);
      L.push('');

      if (r.status === 'failed') {
        L.push(`> **Capture failed:** ${esc(r.error)}`);
        L.push('');
        return;
      }

      L.push('| # | Screen | Screenshot File | Notes |');
      L.push('|---|---|---|---|');
      let n = 0;
      r.captures.forEach((c) => {
        const files = relFiles(c, outputDir);
        // One row per image, so the table lines up 1:1 with the folder.
        files.forEach((f, fi) => {
          n += 1;
          const part = c.slices > 1 ? ` (part ${fi + 1} of ${c.slices}, screen is ${c.contentHeight}px tall)` : '';
          L.push(`| ${n} | ${esc(c.label)} | \`${f}\` | ${esc(c.note || '')}${part} |`);
        });
      });
      L.push('');

      const meta = r.meta || {};
      if (meta.grids && meta.grids.length && meta.grids[0].columns.length) {
        L.push(`**Columns:** ${meta.grids[0].columns.map(esc).join(', ')}`);
        L.push('');
      }
      if (meta.fields && meta.fields.length) {
        const req = meta.fields.filter((f) => f.required).map((f) => `${f.label}*`);
        const opt = meta.fields.filter((f) => !f.required).map((f) => f.label);
        L.push(`**Fields (${meta.fields.length}):** ${[...req, ...opt].map(esc).join(', ')}`);
        L.push('');
      }
      if (meta.buttons && meta.buttons.length) {
        L.push(`**Actions:** ${meta.buttons.map((b) => esc(b.label) + (b.disabled ? ' _(disabled)_' : '')).join(', ')}`);
        L.push('');
      }
      if (meta.tabs && meta.tabs.length) {
        L.push(`**Tabs:** ${meta.tabs.map(esc).join(', ')}`);
        L.push('');
      }
    });

    L.push('---');
    L.push('');
  });

  L.push('## Run Notes');
  L.push('');
  L.push(`- Capture mode: **read-only** — forms were opened but never submitted; \`${manifest.app.blockedMethods.join(', ')}\` requests were blocked at the network layer.`);
  L.push(`- Routes attempted: ${manifest.stats.routes}, failed: ${manifest.stats.failures}`);
  L.push(`- Duration: ${manifest.durationSec}s`);
  L.push('');

  return L.join('\n');
}

// ------------------------------------------------------------------ gallery

function buildGallery(manifest, outputDir) {
  const cards = [];
  manifest.modules.forEach((m, mi) => {
    const items = [];
    m.routes.forEach((r) => {
      r.captures.forEach((c) => {
        relFiles(c, outputDir).forEach((f) => {
          items.push(`
        <figure class="shot">
          <a href="${htmlEsc(f)}" target="_blank"><img loading="lazy" src="${htmlEsc(f)}" alt="${htmlEsc(c.label)}"></a>
          <figcaption><strong>${htmlEsc(r.name)}</strong><span>${htmlEsc(c.label)}</span><code>${htmlEsc(r.path)}</code></figcaption>
        </figure>`);
        });
      });
    });
    if (!items.length) return;
    cards.push(`
    <section id="m${mi}">
      <h2>${pad2(mi + 1)} — ${htmlEsc(m.name)} <span class="count">${items.length}</span></h2>
      <div class="grid">${items.join('')}</div>
    </section>`);
  });

  const nav = manifest.modules
    .map((m, i) => `<a href="#m${i}">${htmlEsc(m.name)}</a>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEsc(manifest.app.displayName)} — Screen Gallery</title>
<style>
  :root { --bg:#fff; --fg:#111827; --muted:#6b7280; --line:#e5e7eb; --card:#f9fafb; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0b0f19; --fg:#e5e7eb; --muted:#9ca3af; --line:#1f2937; --card:#111827; --accent:#60a5fa; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line);
           padding:16px 24px; z-index:10; }
  h1 { margin:0 0 4px; font-size:20px; }
  .meta { color:var(--muted); font-size:13px; }
  nav { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  nav a { font-size:12px; padding:4px 10px; border:1px solid var(--line); border-radius:999px;
          color:var(--fg); text-decoration:none; }
  nav a:hover { border-color:var(--accent); color:var(--accent); }
  section { padding:24px; border-bottom:1px solid var(--line); }
  h2 { font-size:16px; margin:0 0 16px; display:flex; align-items:center; gap:10px; }
  .count { font-size:12px; color:var(--muted); font-weight:400; border:1px solid var(--line);
           border-radius:999px; padding:1px 8px; }
  .grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); }
  .shot { margin:0; background:var(--card); border:1px solid var(--line); border-radius:10px;
          overflow:hidden; }
  .shot img { display:block; width:100%; height:190px; object-fit:cover; object-position:top;
              background:#fff; }
  figcaption { padding:10px 12px; font-size:12px; display:flex; flex-direction:column; gap:2px; }
  figcaption span { color:var(--muted); }
  figcaption code { color:var(--muted); font-size:11px; overflow-wrap:anywhere; }
</style></head>
<body>
<header>
  <h1>${htmlEsc(manifest.app.displayName)} — Screen Gallery</h1>
  <div class="meta">${htmlEsc(manifest.app.baseUrl)} &middot; ${manifest.stats.captures} screenshots &middot;
    ${manifest.modules.length} modules &middot; ${manifest.startedAt.slice(0, 16).replace('T', ' ')}</div>
  <nav>${nav}</nav>
</header>
${cards.join('')}
</body></html>`;
}

// -------------------------------------------------------------------- write

function writeReports(manifest, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  const md = buildPageInventory(manifest, outputDir);
  const mdPath = path.join(outputDir, 'PageInventory.md');
  fs.writeFileSync(mdPath, md, 'utf-8');

  const html = buildGallery(manifest, outputDir);
  const htmlPath = path.join(outputDir, 'gallery.html');
  fs.writeFileSync(htmlPath, html, 'utf-8');

  const jsonPath = path.join(outputDir, 'manifest.json');
  const serialisable = JSON.parse(JSON.stringify(manifest, (k, v) => {
    if (k === 'files') return v.map((f) => path.relative(outputDir, f).split(path.sep).join('/'));
    return v;
  }));
  fs.writeFileSync(jsonPath, JSON.stringify(serialisable, null, 2), 'utf-8');

  return { mdPath, htmlPath, jsonPath };
}

module.exports = { writeReports, buildPageInventory, buildGallery };
