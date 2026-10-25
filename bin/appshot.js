#!/usr/bin/env node
/**
 * appshot — automated screen capture & page inventory for web applications.
 *
 *   appshot capture  --app ccms                 full run
 *   appshot capture  --app ccms --only master   subset by module/route/name
 *   appshot capture  --app ccms --dry-run       list what would be captured
 *   appshot discover --app ccms --save          rebuild the route map from the app nav
 *   appshot init     lims --url http://...      scaffold a new app profile
 *   appshot list                                show available profiles
 */
const fs = require('fs');
const path = require('path');

const { loadConfig, listProfiles, ROOT } = require('../src/config');
const { log, C } = require('../src/logger');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

function usage() {
  console.log(`
${C.bold}appshot${C.reset} — automated screen capture & page inventory

${C.bold}Commands${C.reset}
  add      <name> --url <url>    Build a profile automatically (URL + credentials only)
  capture  --app <name>          Capture every configured screen
  describe --app <name> [--run]  Write the plain-English descriptions for a run
  manual   --app <name> [--run]  Build the operational manual from a capture run
  discover --app <name> [--save] Rebuild the route map from the app's navigation
  init     <name> --url <url>    Scaffold a new application profile
  list                           List available profiles

${C.bold}capture options${C.reset}
  --only <regex>     Capture only routes/modules matching the pattern
  --limit <n>        Stop after n routes
  --headed           Show the browser
  --dry-run          Print the plan, capture nothing
  --out <dir>        Override the output directory
  --no-interactions  Landing screenshot only, skip the recipes
  --describe         Write descriptions straight after capturing
  --manual           Write descriptions and build the manual too

${C.bold}describe options${C.reset}
  --mode ai|basic    ai needs ANTHROPIC_API_KEY; basic uses the captured page structure
  --force            Overwrite descriptions that already exist

${C.bold}Examples${C.reset}
  node bin/appshot.js capture --app ccms
  node bin/appshot.js capture --app ccms --only "master-configuration" --headed
  node bin/appshot.js add lims --url http://lims.example.internal
`);
}

const TEMPLATE = (name, url) => ({
  name,
  displayName: name.toUpperCase(),
  baseUrl: url,
  credentials: {
    username: `\${${name.toUpperCase()}_USER}`,
    password: `\${${name.toUpperCase()}_PASSWORD}`,
  },
  auth: {
    strategy: 'form',
    form: {
      loginPath: '/',
      usernameSelector: 'input[name="username"], input[type="text"]',
      passwordSelector: 'input[type="password"]',
      submitSelector: 'button[type="submit"]',
    },
    verify: { path: '/dashboard', selector: null },
  },
  discovery: {
    enabled: true,
    navSelectors: ['aside', 'nav', '[role="navigation"]'],
    excludePatterns: ['logout', 'signout', '^/$'],
  },
  routes: [],
});

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === 'help' || args.help) return usage();

  if (cmd === 'list') {
    const profiles = listProfiles();
    if (!profiles.length) {
      log.warn('No profiles yet. Create one:  node bin/appshot.js init <name> --url <url>');
      return;
    }
    log.banner('Available application profiles');
    profiles.forEach((p) => {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', `${p}.json`), 'utf-8'));
        const n = (cfg.routes || []).length;
        log.info(`  ${C.bold}${p.padEnd(14)}${C.reset}${C.dim}${cfg.baseUrl || ''}  (${n} route${n === 1 ? '' : 's'})${C.reset}`);
      } catch (e) { log.info(`  ${p}`); }
    });
    return;
  }

  // Build a complete profile from just a URL and credentials.
  if (cmd === 'add') {
    const { generateProfile } = require('../src/profileGen');
    const name = args._[0] || args.name;
    const url = args.url && args.url !== true ? String(args.url) : null;
    const username = (args.user && args.user !== true ? String(args.user) : null) || process.env.DEFAULT_USER;
    const password = (args.password && args.password !== true ? String(args.password) : null) || process.env.DEFAULT_PASSWORD;

    if (!name || !url) {
      log.error('Usage: appshot add <name> --url <baseUrl> [--user <u> --password <p>]');
      log.info('Credentials fall back to DEFAULT_USER / DEFAULT_PASSWORD in .env.');
      process.exitCode = 1; return;
    }
    if (!username || !password) {
      log.error('No credentials. Pass --user/--password once; they are then remembered for next time.');
      process.exitCode = 1; return;
    }

    const r = await generateProfile({ name, baseUrl: url, username, password, headless: !args.headed });
    log.banner(`Profile ready: ${r.name}`);
    const byModule = {};
    r.routes.forEach((x) => { byModule[x.module] = (byModule[x.module] || 0) + 1; });
    Object.entries(byModule).forEach(([m, n]) => log.info(`  ${String(n).padStart(3)}  ${m}`));
    log.info('');
    log.info(`Next:  node bin/appshot.js capture --app ${r.name}`);
    return;
  }

  if (cmd === 'init') {
    const name = args._[0];
    if (!name || !args.url) {
      log.error('Usage: appshot init <name> --url <baseUrl>');
      process.exitCode = 1; return;
    }
    const file = path.join(ROOT, 'apps', `${name}.json`);
    if (fs.existsSync(file) && !args.force) {
      log.error(`${file} already exists (use --force to overwrite)`);
      process.exitCode = 1; return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(TEMPLATE(name, args.url), null, 2), 'utf-8');
    const U = name.toUpperCase();
    log.ok(`Created ${file}`);
    log.info('');
    log.info('Next:');
    log.info(`  1. Add credentials to .env:   ${U}_USER=...   ${U}_PASSWORD=...`);
    log.info(`  2. Check the login selectors and auth.verify.path in the profile`);
    log.info(`  3. node bin/appshot.js discover --app ${name} --save`);
    log.info(`  4. node bin/appshot.js capture  --app ${name}`);
    return;
  }

  const appName = args.app || args._[0];
  if (!appName) { log.error('Missing --app <name>'); process.exitCode = 1; return; }

  const overrides = {};
  if (args.out) overrides.outputDir = String(args.out);
  if (args['no-interactions']) overrides.interactions = { enabled: false };

  const cfg = loadConfig(appName, overrides);

  if (cmd === 'discover') {
    const { chromium } = require('playwright');
    const { authenticate } = require('../src/auth');
    const { discoverRoutes } = require('../src/discover');

    const browser = await chromium.launch({ headless: !args.headed });
    const context = await browser.newContext({
      viewport: cfg.browser.viewport,
      ignoreHTTPSErrors: cfg.browser.ignoreHTTPSErrors,
    });
    try {
      await authenticate(context, cfg);
      const routes = await discoverRoutes(context, cfg);

      log.banner(`${routes.length} route(s) discovered`);
      routes.forEach((r) => log.info(`  ${(r.module || '').padEnd(24)} ${(r.name || '').padEnd(30)} ${C.dim}${r.path}${C.reset}`));

      if (args.save) {
        const profile = JSON.parse(fs.readFileSync(cfg.__profilePath, 'utf-8'));
        profile.routes = routes;
        fs.writeFileSync(cfg.__profilePath, JSON.stringify(profile, null, 2), 'utf-8');
        log.ok(`Saved ${routes.length} route(s) into ${cfg.__profilePath}`);
      } else {
        log.info(`\n${C.dim}Re-run with --save to write these into the profile.${C.reset}`);
      }
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
    return;
  }

  /** Resolve the run to work on: --run <id>, else the most recent. */
  const resolveRun = () => {
    const outputDir = cfg.outputDir;
    let runId = args.run && args.run !== true ? String(args.run) : null;
    if (!runId) {
      const runs = fs.existsSync(outputDir)
        ? fs.readdirSync(outputDir).filter((d) => fs.existsSync(path.join(outputDir, d, 'manifest.json'))).sort()
        : [];
      if (!runs.length) return null;
      runId = runs[runs.length - 1];
    }
    return { runId, runDir: path.join(outputDir, runId) };
  };

  if (cmd === 'describe') {
    const { generateDescriptions } = require('../src/describe');
    const r = resolveRun();
    if (!r) { log.error(`No completed runs in ${cfg.outputDir}`); process.exitCode = 1; return; }

    const res = await generateDescriptions(r.runDir, {
      mode: args.mode && args.mode !== true ? String(args.mode) : 'auto',
      force: !!args.force,
    });
    log.info(`${C.bold}Descriptions:${C.reset} ${res.descPath}`);
    if (res.mode === 'basic') {
      log.info(`${C.dim}Written from the captured screen structure. For descriptions that read like a manual,`);
      log.info(`set ANTHROPIC_API_KEY in .env and re-run with --mode ai --force.${C.reset}`);
    }
    return;
  }

  if (cmd === 'manual') {
    const { generateManual } = require('../src/manual');
    const outputDir = cfg.outputDir;
    let runId = args.run && args.run !== true ? String(args.run) : null;
    if (!runId) {
      const runsDir = fs.existsSync(outputDir)
        ? fs.readdirSync(outputDir).filter((d) => fs.existsSync(path.join(outputDir, d, 'manifest.json'))).sort()
        : [];
      if (!runsDir.length) { log.error(`No completed runs in ${outputDir}`); process.exitCode = 1; return; }
      runId = runsDir[runsDir.length - 1];
    }
    const runDir = path.join(outputDir, runId);
    const r = generateManual(runDir);

    log.banner(`Operational manual — ${cfg.displayName} (${runId})`);
    if (r.scaffolded) {
      log.warn(`No descriptions.json found — wrote an empty one to fill in:`);
      log.info(`  ${r.descPath}`);
    }
    log.ok(`${r.described} of ${r.total} illustrations have a description`);
    if (r.described < r.total) log.warn(`${r.total - r.described} still marked "Description pending"`);
    log.info(`${C.bold}Manual (print/PDF):${C.reset} ${r.htmlPath}`);
    log.info(`${C.bold}Manual (markdown): ${C.reset} ${r.mdPath}`);
    return;
  }

  if (cmd === 'capture') {
    const { run } = require('../src/runner');
    const manifest = await run(cfg, {
      headed: !!args.headed,
      only: args.only && args.only !== true ? String(args.only) : null,
      limit: args.limit && args.limit !== true ? Number(args.limit) : null,
      dryRun: !!args['dry-run'],
      discover: !!args.discover,
    });
    if (manifest && manifest.dryRun) return;

    // Optionally carry straight on into descriptions and the manual.
    const runDir = cfg.runDir;
    if (args.describe || args.manual) {
      const { generateDescriptions } = require('../src/describe');
      await generateDescriptions(runDir, {
        mode: args.mode && args.mode !== true ? String(args.mode) : 'auto',
        force: !!args.force,
      });
    }
    if (args.manual) {
      const { generateManual } = require('../src/manual');
      const m = generateManual(runDir);
      log.ok(`${m.described} of ${m.total} illustrations described`);
      log.info(`${C.bold}Manual:${C.reset} ${m.htmlPath}`);
    }
    return;
  }

  log.error(`Unknown command "${cmd}"`);
  usage();
  process.exitCode = 1;
}

main().catch((e) => {
  log.error(e && e.message ? e.message : String(e));
  if (process.env.APPSHOT_DEBUG) console.error(e);
  process.exitCode = 1;
});
