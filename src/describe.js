/**
 * describe.js — write the plain-English descriptions the manual needs.
 *
 * Two modes, chosen by whether an API key is configured:
 *
 *   'ai'     Each screen's images are sent to Claude, which looks at them and
 *            writes a title and 1-3 sentences per image in the house style.
 *            All slices of one screen go in a single request so Top/Middle/
 *            Bottom read as a continuous walk down the page. This is what
 *            produced the CCMS and CAPA manuals.
 *
 *   'basic'  No key, no network. Descriptions are composed from the structure
 *            already captured for each screen — its headings, grid columns,
 *            field list and buttons. Factual and immediately available, but
 *            flatter than the written version, and it cannot describe what a
 *            chart shows or which part of a long form you are looking at.
 *
 * NOTE ON DATA: the 'ai' mode uploads screenshots to Anthropic's API. Those
 * images contain whatever was on screen, including real records. It is opt-in
 * for that reason and never runs unless explicitly requested.
 */
const fs = require('fs');
const path = require('path');
const { log, C } = require('./logger');

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_IMAGES_PER_REQUEST = 6;

const STYLE = `You are writing descriptions of software screenshots for an OPERATIONAL MANUAL given to end users of a regulated pharmaceutical quality system. The readers are QA officers, production and engineering staff — NOT software people.

Rules:
- 1-3 sentences per image. Say what the screen is for, then what the user can do on it.
- Plain words only. Say "list" not "grid"; "pop-up window" not "modal"; "selection list" not "dropdown"; "screen" not "page". Never mention URLs, code, CSS or browsers.
- Name the actual buttons, columns and headings VISIBLE in the image, using the on-screen wording.
- Images marked as part N of M are consecutive parts of ONE long screen captured by scrolling down. Describe THAT PART and orient the reader ("Upper part of the form, where you enter...", "Continuing down the same form...", "Bottom of the screen, with the ... buttons").
- Distinguish read-only detail shown for reference from the parts the user actually fills in.
- Describe only what is visible. Never invent features. If something is empty, blank or shows an error, say so plainly and neutrally — that is useful information.
- Vary your phrasing; do not start every description the same way.
- Give each image a short title (3-8 words).`;

function readImageBase64(file) {
  return fs.readFileSync(file).toString('base64');
}

function relFiles(capture, runDir) {
  return (capture.files || []).map((f) =>
    (path.isAbsolute(f) ? path.relative(runDir, f) : f).split(path.sep).join('/'));
}

/** Every image in the run, with the context needed to describe it. */
function collectScreens(manifest, runDir) {
  const screens = [];
  manifest.modules.forEach((mod) => {
    mod.routes.forEach((route) => {
      const images = [];
      route.captures.forEach((c) => {
        relFiles(c, runDir).forEach((file, i) => {
          images.push({ file, label: c.label, part: i + 1, of: c.files.length, note: c.note });
        });
      });
      if (images.length) {
        screens.push({ module: mod.name, screen: route.name, path: route.path, meta: route.meta, images });
      }
    });
  });
  return screens;
}

// ------------------------------------------------------------------ ai mode

async function callClaude(apiKey, model, screen, batch, runDir) {
  const content = [];
  content.push({
    type: 'text',
    text:
      `Application section: ${screen.module}\n` +
      `Screen: ${screen.screen}\n` +
      (screen.images.length > 1
        ? `This screen was captured in ${screen.images.length} parts by scrolling down.\n`
        : '') +
      `\nDescribe each of the ${batch.length} image(s) below, in order.`,
  });

  for (const img of batch) {
    const partInfo = img.of > 1 ? ` (part ${img.part} of ${img.of} of this screen)` : '';
    content.push({ type: 'text', text: `\nImage: ${img.label}${partInfo}` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: readImageBase64(path.join(runDir, img.file)) },
    });
  }

  content.push({
    type: 'text',
    text:
      `\nReturn ONLY a JSON array with one object per image, in the same order, each like ` +
      `{"title":"...","description":"..."}. No prose outside the JSON.`,
  });

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: STYLE,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Claude did not return a JSON array');
  return JSON.parse(match[0]);
}

async function describeWithAi(screens, runDir, opts) {
  const apiKey = opts.apiKey;
  const model = opts.model || DEFAULT_MODEL;
  const images = {};
  let done = 0;
  const total = screens.reduce((n, s) => n + s.images.length, 0);

  for (const screen of screens) {
    for (let i = 0; i < screen.images.length; i += MAX_IMAGES_PER_REQUEST) {
      const batch = screen.images.slice(i, i + MAX_IMAGES_PER_REQUEST);
      try {
        const out = await callClaude(apiKey, model, screen, batch, runDir);
        batch.forEach((img, k) => {
          const d = out[k] || {};
          if (d.description) {
            images[img.file] = { title: d.title || img.label.replace(/_/g, ' '), description: d.description };
          }
        });
      } catch (e) {
        log.warn(`${screen.screen}: ${String(e.message).split('\n')[0]}`);
      }
      done += batch.length;
      if (opts.onProgress) opts.onProgress({ done, total, screen: screen.screen });
      log.step(`${done}/${total}  ${screen.module} — ${screen.screen}`);
    }
  }
  return images;
}

// --------------------------------------------------------------- basic mode

function list(items, max) {
  const a = items.slice(0, max);
  const rest = items.length - a.length;
  return a.join(', ') + (rest > 0 ? `, and ${rest} more` : '');
}

/**
 * Compose a factual description from what was inspected on the screen. No
 * network, no key — but it can only report structure, so it says nothing about
 * what a chart shows or what a particular part of a long form contains.
 */
function describeFromStructure(screen, img) {
  const m = screen.meta || {};
  const bits = [];
  const kind = /grid/i.test(img.label) ? 'list'
    : /add/i.test(img.label) ? 'form for adding a new record'
    : /edit/i.test(img.label) ? 'form for changing an existing record'
    : /view/i.test(img.label) ? 'read-only detail view'
    : 'screen';

  if (img.of > 1) {
    const where = img.part === 1 ? 'Top' : img.part === img.of ? 'Bottom' : 'Middle';
    bits.push(`${where} of the ${screen.screen} ${kind} (part ${img.part} of ${img.of}, captured by scrolling down).`);
  } else {
    bits.push(`The ${screen.screen} ${kind}.`);
  }

  const grid = (m.grids || [])[0];
  if (grid && grid.columns && grid.columns.length) {
    bits.push(`The list shows ${list(grid.columns, 8)}.`);
  }
  const fields = m.fields || [];
  if (fields.length) {
    const req = fields.filter((f) => f.required).map((f) => f.label);
    if (req.length) bits.push(`Fields that must be completed: ${list(req, 8)}.`);
    const opt = fields.filter((f) => !f.required).map((f) => f.label);
    if (opt.length) bits.push(`Other fields: ${list(opt, 8)}.`);
  }
  const buttons = (m.buttons || []).filter((b) => !b.disabled).map((b) => b.label);
  if (buttons.length) bits.push(`Available actions: ${list(buttons, 8)}.`);
  if ((m.tabs || []).length) bits.push(`Tabs: ${list(m.tabs, 8)}.`);

  return bits.join(' ');
}

function describeBasic(screens) {
  const images = {};
  screens.forEach((screen) => {
    screen.images.forEach((img) => {
      images[img.file] = {
        title: `${screen.screen} — ${img.label.replace(/_/g, ' ')}`,
        description: describeFromStructure(screen, img),
      };
    });
  });
  return images;
}

// -------------------------------------------------------------------- entry

/**
 * Write descriptions.json for a capture run.
 * opts: { mode: 'ai'|'basic'|'auto', apiKey, model, force, onProgress }
 */
async function generateDescriptions(runDir, opts = {}) {
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`No manifest.json in ${runDir}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || null;
  let mode = opts.mode || 'auto';
  if (mode === 'auto') mode = apiKey ? 'ai' : 'basic';
  if (mode === 'ai' && !apiKey) {
    throw new Error('Writing descriptions with Claude needs ANTHROPIC_API_KEY in .env (or switch to the basic mode).');
  }

  const screens = collectScreens(manifest, runDir);
  const total = screens.reduce((n, s) => n + s.images.length, 0);
  log.group(`Writing descriptions for ${total} image(s) — ${mode} mode`);

  const descPath = path.join(runDir, 'descriptions.json');
  const existing = fs.existsSync(descPath)
    ? JSON.parse(fs.readFileSync(descPath, 'utf-8'))
    : { app: {}, moduleTitles: {}, modules: {}, images: {} };

  let images;
  try {
    images = mode === 'ai'
      ? await describeWithAi(screens, runDir, { apiKey, model: opts.model, onProgress: opts.onProgress })
      : describeBasic(screens);
  } finally {
    log.groupEnd();
  }

  // Never overwrite text somebody has already written unless asked to.
  const merged = Object.assign({}, existing.images || {});
  let written = 0;
  for (const [file, d] of Object.entries(images)) {
    if (!opts.force && merged[file] && merged[file].description) continue;
    merged[file] = d;
    written += 1;
  }

  const moduleTitles = Object.assign({}, existing.moduleTitles || {});
  const modules = Object.assign({}, existing.modules || {});
  manifest.modules.forEach((m) => {
    if (!(m.name in moduleTitles)) moduleTitles[m.name] = m.name;
    if (!(m.name in modules)) modules[m.name] = '';
  });

  const app = Object.assign(
    { title: `${manifest.app.displayName} — Operational Manual`, intro: '' },
    existing.app || {}
  );

  fs.writeFileSync(descPath, JSON.stringify({ app, moduleTitles, modules, images: merged }, null, 1), 'utf-8');
  log.ok(`${written} description(s) written, ${Object.keys(merged).length}/${total} covered`);
  return { descPath, mode, written, covered: Object.keys(merged).length, total };
}

module.exports = { generateDescriptions };
