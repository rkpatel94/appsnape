/**
 * manual.js — compile captured screens + written descriptions into an
 * operational manual for end users.
 *
 * The capture run gives us the screenshots and their order; a descriptions file
 * gives each image a plain-English title and explanation. This module joins the
 * two into a printable document.
 *
 * Descriptions live in the run folder as `descriptions.json`:
 *
 *   {
 *     "app":     { "title": "...", "intro": "..." },
 *     "modules": { "Dashboard": "what this section of the system is for" },
 *     "images":  { "01_Dashboard/.../01_Top.png": { "title": "...", "description": "..." } }
 *   }
 *
 * Anything missing degrades gracefully: a screen with no description still
 * appears, flagged, so gaps are visible rather than silently dropped.
 */
const fs = require('fs');
const path = require('path');

function pad2(n) { return String(n).padStart(2, '0'); }

function htmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relFiles(capture, runDir) {
  return (capture.files || []).map((f) =>
    (path.isAbsolute(f) ? path.relative(runDir, f) : f).split(path.sep).join('/'));
}

/** Flatten the manifest into the manual's ordered structure. */
function buildOutline(manifest, runDir, desc) {
  const images = desc.images || {};
  // Module names come from the application's own menu, which is not always how
  // you would title a section in a document ("Capa" -> "CAPA Workflow").
  // `moduleTitles` renames them for the manual without re-capturing.
  const titles = desc.moduleTitles || {};
  return manifest.modules.map((mod, mi) => ({
    number: pad2(mi + 1),
    name: titles[mod.name] || mod.name,
    intro: (desc.modules || {})[mod.name] || '',
    screens: mod.routes.map((r, ri) => {
      const figures = [];
      r.captures.forEach((c) => {
        relFiles(c, runDir).forEach((file) => {
          const d = images[file] || {};
          figures.push({
            file,
            title: d.title || c.label.replace(/_/g, ' '),
            description: d.description || null,
            missing: !d.description,
          });
        });
      });
      return {
        number: `${pad2(mi + 1)}.${ri + 1}`,
        name: r.name,
        status: r.status,
        error: r.error,
        figures,
      };
    }),
  }));
}

// -------------------------------------------------------------------- markdown

function buildMarkdown(manifest, outline, desc) {
  const L = [];
  const title = (desc.app && desc.app.title) || `${manifest.app.displayName} — Operational Manual`;

  L.push(`# ${title}`);
  L.push('');
  L.push(`**System:** ${manifest.app.displayName}`);
  L.push(`**Document date:** ${manifest.startedAt.slice(0, 10)}`);
  L.push(`**Screens covered:** ${manifest.stats.routes}`);
  L.push(`**Illustrations:** ${manifest.stats.captures}`);
  L.push('');

  if (desc.app && desc.app.intro) { L.push(desc.app.intro); L.push(''); }

  L.push('---');
  L.push('');
  L.push('## Contents');
  L.push('');
  outline.forEach((m) => {
    L.push(`${m.number}. **${m.name}**`);
    m.screens.forEach((s) => L.push(`    - ${s.number} ${s.name}`));
  });
  L.push('');
  L.push('---');
  L.push('');

  outline.forEach((m) => {
    L.push(`## ${m.number}. ${m.name}`);
    L.push('');
    if (m.intro) { L.push(m.intro); L.push(''); }

    m.screens.forEach((s) => {
      L.push(`### ${s.number} ${s.name}`);
      L.push('');
      if (s.status === 'failed') {
        L.push(`_This screen could not be captured: ${s.error}_`);
        L.push('');
        return;
      }
      s.figures.forEach((f, i) => {
        L.push(`**${s.number}.${i + 1} ${f.title}**`);
        L.push('');
        L.push(`![${f.title}](${f.file})`);
        L.push('');
        L.push(f.description || '_Description pending._');
        L.push('');
      });
    });
    L.push('---');
    L.push('');
  });

  return L.join('\n');
}

// ------------------------------------------------------------------------ html

function buildHtml(manifest, outline, desc) {
  const title = (desc.app && desc.app.title) || `${manifest.app.displayName} — Operational Manual`;

  const toc = outline.map((m) => `
      <li><a href="#m${m.number}">${m.number}. ${htmlEsc(m.name)}</a>
        <ul>${m.screens.map((s) => `<li><a href="#s${s.number}">${s.number} ${htmlEsc(s.name)}</a></li>`).join('')}</ul>
      </li>`).join('');

  const body = outline.map((m) => `
    <section class="module" id="m${m.number}">
      <h2>${m.number}. ${htmlEsc(m.name)}</h2>
      ${m.intro ? `<p class="intro">${htmlEsc(m.intro)}</p>` : ''}
      ${m.screens.map((s) => `
        <section class="screen" id="s${s.number}">
          <h3>${s.number} ${htmlEsc(s.name)}</h3>
          ${s.status === 'failed'
            ? `<p class="missing">This screen could not be captured: ${htmlEsc(s.error)}</p>`
            : s.figures.map((f, i) => `
            <figure>
              <figcaption class="cap">
                <span class="fignum">${s.number}.${i + 1}</span> ${htmlEsc(f.title)}
              </figcaption>
              <img src="${htmlEsc(f.file)}" alt="${htmlEsc(f.title)}" loading="lazy">
              <p class="${f.missing ? 'desc missing' : 'desc'}">
                ${htmlEsc(f.description || 'Description pending.')}
              </p>
            </figure>`).join('')}
        </section>`).join('')}
    </section>`).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEsc(title)}</title>
<style>
  :root { --ink:#111827; --muted:#6b7280; --line:#d7dce3; --accent:#0f766e; }
  * { box-sizing: border-box; }
  body { margin:0; color:var(--ink); background:#eef1f5;
         font:15px/1.65 "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; }
  .sheet { max-width: 980px; margin: 0 auto; background:#fff; padding: 56px 64px; }

  h1 { font-size: 30px; margin:0 0 8px; }
  h2 { font-size: 22px; color:var(--accent); margin: 0 0 6px;
       padding-bottom: 8px; border-bottom: 2px solid var(--accent); }
  h3 { font-size: 17px; margin: 28px 0 4px; }
  .meta { color:var(--muted); font-size: 13.5px; margin-bottom: 18px; }
  .meta b { color: var(--ink); font-weight: 600; }
  .lead { font-size: 15.5px; }

  nav.toc { background:#f7f9fb; border:1px solid var(--line); border-radius:8px;
            padding: 18px 24px; margin: 26px 0 10px; }
  nav.toc h4 { margin:0 0 10px; font-size:14px; text-transform:uppercase;
               letter-spacing:.06em; color:var(--muted); }
  nav.toc ul { margin:0; padding-left: 20px; }
  nav.toc > ul > li { margin-bottom: 6px; font-weight:600; }
  nav.toc ul ul { padding-left: 16px; margin: 3px 0 0; }
  nav.toc ul ul li { font-weight: 400; font-size: 14px; }
  nav.toc a { color: var(--ink); text-decoration: none; }
  nav.toc a:hover { color: var(--accent); text-decoration: underline; }

  section.module { margin-top: 44px; }
  section.screen { margin-top: 22px; }
  p.intro { color:#374151; margin: 10px 0 0; }

  figure { margin: 16px 0 26px; border:1px solid var(--line); border-radius:8px;
           overflow:hidden; background:#fff; break-inside: avoid; page-break-inside: avoid; }
  figure img { display:block; width:100%; border-top:1px solid var(--line);
               border-bottom:1px solid var(--line); }
  figcaption.cap { padding: 9px 14px; background:#f7f9fb; font-weight:600; font-size:14px; }
  .fignum { color: var(--accent); margin-right: 6px; }
  p.desc { margin:0; padding: 12px 14px; font-size: 14.5px; }
  p.missing { color:#b45309; font-style: italic; }

  @media print {
    body { background:#fff; }
    .sheet { max-width:none; padding: 0; }
    nav.toc { break-after: page; page-break-after: always; }
    section.module { break-before: page; page-break-before: always; }
    figure { border-color:#999; }
    a { color: inherit; text-decoration: none; }
  }
</style></head>
<body>
<div class="sheet">
  <h1>${htmlEsc(title)}</h1>
  <p class="meta">
    <b>System:</b> ${htmlEsc(manifest.app.displayName)} &nbsp;·&nbsp;
    <b>Document date:</b> ${manifest.startedAt.slice(0, 10)} &nbsp;·&nbsp;
    <b>Screens covered:</b> ${manifest.stats.routes} &nbsp;·&nbsp;
    <b>Illustrations:</b> ${manifest.stats.captures}
  </p>
  ${desc.app && desc.app.intro ? `<p class="lead">${htmlEsc(desc.app.intro)}</p>` : ''}

  <nav class="toc"><h4>Contents</h4><ul>${toc}</ul></nav>
  ${body}
</div>
</body></html>`;
}

// ------------------------------------------------------------------ scaffold

/** Emit an empty descriptions file so the gaps are obvious and fillable. */
function buildScaffold(manifest, runDir) {
  const images = {};
  manifest.modules.forEach((mod) => {
    mod.routes.forEach((r) => {
      r.captures.forEach((c) => {
        relFiles(c, runDir).forEach((f) => {
          images[f] = { title: c.label.replace(/_/g, ' '), description: '' };
        });
      });
    });
  });
  const modules = {};
  const moduleTitles = {};
  manifest.modules.forEach((m) => { modules[m.name] = ''; moduleTitles[m.name] = m.name; });
  return {
    app: { title: `${manifest.app.displayName} — Operational Manual`, intro: '' },
    moduleTitles,
    modules,
    images,
  };
}

function generateManual(runDir) {
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`No manifest.json in ${runDir}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  const descPath = path.join(runDir, 'descriptions.json');
  let desc;
  let scaffolded = false;
  if (fs.existsSync(descPath)) {
    desc = JSON.parse(fs.readFileSync(descPath, 'utf-8'));
  } else {
    desc = buildScaffold(manifest, runDir);
    fs.writeFileSync(descPath, JSON.stringify(desc, null, 1), 'utf-8');
    scaffolded = true;
  }

  const outline = buildOutline(manifest, runDir, desc);
  const mdPath = path.join(runDir, 'OperationalManual.md');
  const htmlPath = path.join(runDir, 'OperationalManual.html');
  fs.writeFileSync(mdPath, buildMarkdown(manifest, outline, desc), 'utf-8');
  fs.writeFileSync(htmlPath, buildHtml(manifest, outline, desc), 'utf-8');

  let described = 0;
  let total = 0;
  outline.forEach((m) => m.screens.forEach((s) => s.figures.forEach((f) => {
    total += 1; if (!f.missing) described += 1;
  })));

  return { mdPath, htmlPath, descPath, scaffolded, described, total };
}

module.exports = { generateManual, buildScaffold };
