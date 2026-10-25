/**
 * inspect.js — pull the structural facts out of a rendered screen.
 *
 * The screenshots show what a page looks like; this is what makes the
 * generated inventory useful to a tester: the field list, the action buttons,
 * the grid columns. It runs entirely in the page and touches nothing.
 */

const EXTRACT = () => {
  const text = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  // ---- Field label resolution -------------------------------------------
  // Tries, in order: <label for>, wrapping <label>, aria-label,
  // aria-labelledby, MUI InputLabel sibling, placeholder, name.
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return text(l);
    }
    const wrap = el.closest('label');
    if (wrap) return text(wrap);
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const parts = by.split(/\s+/).map((id) => text(document.getElementById(id))).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    const formControl = el.closest('.MuiFormControl-root, .MuiTextField-root');
    if (formControl) {
      const lbl = formControl.querySelector('label, .MuiFormLabel-root');
      if (lbl) return text(lbl);
    }
    if (el.placeholder) return el.placeholder.trim();
    return el.getAttribute('name') || '';
  };

  const isRequired = (el) => {
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    const lbl = labelFor(el);
    return /\*\s*$/.test(lbl);
  };

  // The app shell (sidebar, top bar) is identical on every screen — listing it
  // as this screen's fields/actions would repeat the same 12 nav items across
  // every entry in the inventory and bury the controls that matter.
  const SHELL = 'nav, aside, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';
  const inShell = (el) => !!el.closest(SHELL);
  // Column-header sort buttons are already reported as Columns.
  const inTableHead = (el) => !!el.closest('thead');

  // ---- Fields ------------------------------------------------------------
  const fieldNodes = Array.from(
    document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="combobox"]')
  ).filter((el) => visible(el) && el.type !== 'hidden' && !inShell(el));

  const seenField = new Set();
  const fields = [];
  for (const el of fieldNodes) {
    const label = labelFor(el).replace(/\s*\*\s*$/, '').trim();
    const name = el.getAttribute('name') || '';
    const key = `${label}|${name}|${el.getAttribute('placeholder') || ''}`;
    if (seenField.has(key)) continue;
    seenField.add(key);
    fields.push({
      label: label || '(unlabelled)',
      name: name || null,
      placeholder: el.getAttribute('placeholder') || null,
      type: (el.tagName === 'INPUT' ? (el.type || 'text') : el.tagName.toLowerCase()),
      required: isRequired(el),
      readOnly: !!(el.readOnly || el.getAttribute('aria-readonly') === 'true' || el.disabled),
    });
  }

  // ---- Buttons / actions -------------------------------------------------
  const buttonNodes = Array.from(
    document.querySelectorAll('button, [role="button"], a.btn, input[type="submit"], input[type="button"]')
  ).filter((el) => visible(el) && !inShell(el) && !inTableHead(el));
  const buttons = [];
  const seenBtn = new Set();
  for (const el of buttonNodes) {
    const label = (text(el) || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    if (!label || label.length > 60) continue;
    if (seenBtn.has(label.toLowerCase())) continue;
    seenBtn.add(label.toLowerCase());
    buttons.push({ label, disabled: !!el.disabled });
  }

  // ---- Grid --------------------------------------------------------------
  const tables = Array.from(document.querySelectorAll('table')).filter(visible);
  const grids = tables.map((t) => {
    const headers = Array.from(t.querySelectorAll('thead th, thead td')).map(text).filter(Boolean);
    const rows = t.querySelectorAll('tbody tr').length;
    return { columns: headers, rowCount: rows };
  });

  // ---- Tabs / sections ---------------------------------------------------
  const tabs = Array.from(document.querySelectorAll('[role="tab"]')).filter(visible).map(text).filter(Boolean);
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'))
    .filter(visible).map(text).filter(Boolean).slice(0, 25);

  // ---- Validation messages currently on screen ---------------------------
  const errors = Array.from(
    document.querySelectorAll('.Mui-error, .MuiFormHelperText-root.Mui-error, [role="alert"], .error-message, .text-red-500, .text-red-600')
  ).filter(visible).map(text).filter((t) => t && t.length < 200);

  return {
    title: document.title || '',
    heading: headings[0] || '',
    headings,
    fields,
    buttons,
    grids,
    tabs,
    errors: [...new Set(errors)],
    hasModal: !!document.querySelector('[role="dialog"]'),
  };
};

async function inspectPage(page) {
  try {
    return await page.evaluate(EXTRACT);
  } catch (e) {
    return { title: '', heading: '', headings: [], fields: [], buttons: [], grids: [], tabs: [], errors: [], hasModal: false };
  }
}

module.exports = { inspectPage };
