/**
 * logger.js — minimal console logger with levels + indentation.
 * No external deps (keeps the tool installable behind a corporate proxy).
 */
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m', bold: '\x1b[1m',
};

let indent = 0;
const pad = () => '  '.repeat(indent);

// Optional second destination for every line — used by the UI server to stream
// a run's progress to the browser without changing any call site.
let sink = null;
function emit(level, msg) {
  if (sink) { try { sink({ level, message: String(msg), indent }); } catch (e) { /* never break a run for logging */ } }
}

const log = {
  setSink(fn) { sink = fn; },
  group(msg) { console.log(`\n${pad()}${C.bold}${C.cyan}> ${msg}${C.reset}`); emit('group', msg); indent++; },
  groupEnd() { indent = Math.max(0, indent - 1); },
  info(msg) { console.log(`${pad()}${msg}`); emit('info', msg); },
  step(msg) { console.log(`${pad()}${C.dim}-${C.reset} ${msg}`); emit('step', msg); },
  ok(msg) { console.log(`${pad()}${C.green}OK${C.reset} ${msg}`); emit('ok', msg); },
  warn(msg) { console.log(`${pad()}${C.yellow}!${C.reset} ${msg}`); emit('warn', msg); },
  error(msg) { console.log(`${pad()}${C.red}X${C.reset} ${msg}`); emit('error', msg); },
  skip(msg) { console.log(`${pad()}${C.dim}o ${msg}${C.reset}`); emit('skip', msg); },
  banner(msg) { console.log(`\n${C.bold}${C.blue}${msg}${C.reset}`); emit('banner', msg); },
};

/** Strip ANSI colour codes — the UI renders plain text. */
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

module.exports = { log, C, stripAnsi };
