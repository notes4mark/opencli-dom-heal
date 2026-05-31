#!/usr/bin/env node
/**
 * dom-heal CLI — simplified subcommand interface for DOM health maintenance.
 *
 * Usage:
 *   node cli.mjs check doubao
 *   node cli.mjs diagnose doubao --role send_button
 *   node cli.mjs save doubao
 *   node cli.mjs changes doubao
 *   node cli.mjs audit
 *   node cli.mjs show doubao
 *   node cli.mjs onboard <site>
 *   node cli.mjs test [--watch]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listSnapshots } from './lib/snapshots.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = __dirname;
const LIB_DIR = resolve(SKILL_DIR, 'lib');

function resolveBaselinesDir() {
  if (process.env.DOM_HEAL_BASELINES) return process.env.DOM_HEAL_BASELINES;
  return resolve(SKILL_DIR, 'baselines');
}
const BASELINES_DIR = resolveBaselinesDir();
const REGISTRY_PATH = resolve(BASELINES_DIR, 'registry.json');

function loadRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
}

function loadBaseline(site) {
  const path = resolve(BASELINES_DIR, site, 'selector-roles.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function getDefaultUrl(site) {
  const reg = loadRegistry();
  const entry = reg.sites[site];
  if (entry?.default_url) return entry.default_url;
  // Fallback: derive from adapter domain
  return null;
}

function getSessionName(site, args) {
  const sessionIdx = args.indexOf('--session');
  if (sessionIdx !== -1 && args[sessionIdx + 1]) return args[sessionIdx + 1];
  return site;
}

function ensureBrowserSession(site, session, url) {
  if (!url) return;
  try {
    // Check current URL to see if we need to navigate
    const currentUrl = execSync(`opencli browser ${session} get url 2>/dev/null`, { stdio: 'pipe', encoding: 'utf-8' }).trim();
    if (!currentUrl || !currentUrl.startsWith(url.split('/').slice(0, 3).join('/'))) {
      // Wrong page or couldn't get URL — navigate
      console.log(`  Opening ${url} ...`);
      execSync(`opencli browser ${session} open "${url}"`, { stdio: 'pipe' });
    }
  } catch {
    // Session doesn't exist or browser not connected — open it
    console.log(`  Opening ${url} ...`);
    try {
      execSync(`opencli browser ${session} open "${url}"`, { stdio: 'pipe' });
    } catch (e) {
      console.error(`  Warning: Could not open browser session. Is Chrome running?`);
      console.error(`  Run: opencli doctor`);
    }
  }
}

function runAnalyze(site, args = '') {
  const script = resolve(LIB_DIR, 'analyze.mjs');
  const cmd = `node "${script}" --site ${site} ${args}`.trim();
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', timeout: 60000 });
  } catch (e) {
    // analyze.mjs uses exit codes: 0=ok, 1=degraded, 2=critical
    return e.stdout || e.stderr || '';
  }
}

function runHeal(site, analysisPath, role = null) {
  const script = resolve(LIB_DIR, 'heal.mjs');
  const roleArg = role ? `--role ${role}` : '';
  try {
    return execSync(
      `node "${script}" --site ${site} --analysis "${analysisPath}" ${roleArg}`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: 30000 }
    );
  } catch (e) {
    return e.stdout || e.stderr || '';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Subcommand: check — health check against baseline
// ══════════════════════════════════════════════════════════════════════════════
function cmdCheck(site, args) {
  const session = getSessionName(site, args);
  const url = getDefaultUrl(site);

  console.log(`\n=== dom-heal check: ${site} ===\n`);

  if (url) {
    ensureBrowserSession(site, session, url);
  } else {
    console.log(`  No default_url for ${site}. Ensure browser is on the right page.`);
  }

  const output = runAnalyze(site, `--session ${session} --compare`);
  console.log(output);

  // Parse exit code from analyze output
  const critical = output.includes('CRITICAL');
  const degraded = output.includes('DEGRADED');
  if (critical) process.exitCode = 2;
  else if (degraded) process.exitCode = 1;
}

// ══════════════════════════════════════════════════════════════════════════════
// Subcommand: diagnose — full analyze → compare → heal pipeline
// ══════════════════════════════════════════════════════════════════════════════
function cmdDiagnose(site, args) {
  const session = getSessionName(site, args);
  const url = getDefaultUrl(site);
  const roleIdx = args.indexOf('--role');
  const role = roleIdx !== -1 ? args[roleIdx + 1] : null;

  console.log(`\n=== dom-heal diagnose: ${site}${role ? ' --role ' + role : ''} ===\n`);

  if (url) {
    ensureBrowserSession(site, session, url);
  }

  // Step 1: capture snapshot
  const tmpFile = `/tmp/dom-heal-${site}-snapshot.json`;
  console.log('Step 1/3: Capturing DOM analysis...');
  const analyzeOut = runAnalyze(site, `--session ${session} --output "${tmpFile}"`);
  console.log(analyzeOut);

  // Step 2: compare with baseline
  console.log('Step 2/3: Comparing with baseline...');
  const compareOut = runAnalyze(site, `--session ${session} --compare`);
  console.log(compareOut);

  // Step 3: run healing for broken roles
  console.log('Step 3/3: Scoring replacement candidates...');
  const healOut = runHeal(site, tmpFile, role);
  console.log(healOut);
}

// ══════════════════════════════════════════════════════════════════════════════
// Subcommand: save — snapshot + update baseline + update registry
// ══════════════════════════════════════════════════════════════════════════════
function cmdSave(site, args) {
  const session = getSessionName(site, args);
  const url = getDefaultUrl(site);

  console.log(`\n=== dom-heal save: ${site} ===\n`);

  if (url) {
    ensureBrowserSession(site, session, url);
  }

  console.log('Running analyze --compare --save --update...');
  const output = runAnalyze(site, `--session ${session} --compare --save --update`);
  console.log(output);

  // Show updated registry status
  const reg = loadRegistry();
  const entry = reg.sites[site];
  if (entry) {
    console.log(`\nRegistry updated:`);
    console.log(`  health:    ${entry.health}`);
    console.log(`  last_check: ${entry.last_check || 'now'}`);
    if (entry.broken_roles?.length) console.log(`  broken:    ${entry.broken_roles.join(', ')}`);
    if (entry.degraded_roles?.length) console.log(`  degraded:  ${entry.degraded_roles.join(', ')}`);
  }

  // List snapshots
  try {
    const list = listSnapshots(site);
    if (list.length) {
      console.log(`\nSnapshots (${list.length}/10):`);
      for (const s of list.slice(-3)) console.log(`  ${s.file}`);
      if (list.length > 3) console.log(`  ... and ${list.length - 3} more`);
    }
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// Subcommand: changes — diff current analysis vs last snapshot
// ══════════════════════════════════════════════════════════════════════════════
function cmdChanges(site, args) {
  const session = getSessionName(site, args);
  const url = getDefaultUrl(site);

  console.log(`\n=== dom-heal changes: ${site} ===\n`);

  if (url) {
    ensureBrowserSession(site, session, url);
  }

  const output = runAnalyze(site, `--session ${session} --changes`);
  console.log(output);
}

// ══════════════════════════════════════════════════════════════════════════════
// Subcommand: audit — batch health check across all registry sites
// ══════════════════════════════════════════════════════════════════════════════
function cmdAudit() {
  const reg = loadRegistry();
  const sites = Object.entries(reg.sites).filter(([name, v]) =>
    !name.startsWith('test-') && !name.startsWith('test_integ')
  );

  console.log(`\n=== dom-heal audit: ${sites.length} sites ===\n`);

  const results = [];
  for (const [site, entry] of sites) {
    const baseline = loadBaseline(site);
    if (!baseline) {
      results.push({ site, roles: 0, selectors: 0, broken: [], health: 'no baseline' });
      continue;
    }

    const roles = Object.keys(baseline.roles);
    const totalSelectors = roles.reduce((s, r) => s + baseline.roles[r].selectors.length, 0);
    const brokenRoles = roles.filter(r =>
      baseline.roles[r].selectors.length > 0 &&
      baseline.roles[r].selectors.every(s => s.status === 'broken')
    );
    const degradedRoles = roles.filter(r => {
      const sels = baseline.roles[r].selectors;
      return sels.some(s => s.status === 'broken') && sels.some(s => s.status !== 'broken');
    });

    const health = brokenRoles.length > 0 ? 'critical'
      : degradedRoles.length > 0 ? 'degraded'
      : entry.health === 'unknown' ? 'unknown' : 'ok';

    results.push({
      site,
      version: baseline.schema_version,
      roles: roles.length,
      selectors: totalSelectors,
      broken: brokenRoles,
      degraded: degradedRoles,
      health,
      last_check: entry.last_check,
    });
  }

  // Format table
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('Site', 14)} ${pad('v', 3)} ${pad('Roles', 6)} ${pad('Sels', 5)} ${pad('Health', 10)} Last Check`);
  console.log('─'.repeat(70));
  for (const r of results) {
    const healthIcon = r.health === 'critical' ? 'CRITICAL' : r.health === 'degraded' ? 'DEGRADED' : r.health === 'ok' ? 'OK' : '?';
    const lastCheck = r.last_check ? r.last_check.slice(0, 10) : 'never';
    console.log(`${pad(r.site, 14)} ${pad(String(r.version), 3)} ${pad(String(r.roles), 6)} ${pad(String(r.selectors), 5)} ${pad(healthIcon, 10)} ${lastCheck}`);
  }

  // Detail on broken/degraded
  const problems = results.filter(r => r.broken.length || r.degraded.length);
  if (problems.length) {
    console.log(`\n--- Issues ---`);
    for (const r of problems) {
      if (r.broken.length) console.log(`  ${r.site}: BROKEN → ${r.broken.join(', ')}`);
      if (r.degraded.length) console.log(`  ${r.site}: DEGRADED → ${r.degraded.join(', ')}`);
    }
  }

  console.log(`\nRun 'node cli.mjs check <site>' for detailed health report.`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Subcommand: show — display baseline info for a site
// ══════════════════════════════════════════════════════════════════════════════
function cmdShow(site) {
  const baseline = loadBaseline(site);
  if (!baseline) {
    console.error(`No baseline found for "${site}". Available: ${Object.keys(loadRegistry().sites).join(', ')}`);
    process.exit(1);
  }

  const reg = loadRegistry();
  const entry = reg.sites[site];

  console.log(`\n=== ${site} ===`);
  console.log(`Schema:     v${baseline.schema_version}`);
  console.log(`Updated:    ${baseline.updated}`);
  console.log(`URL:        ${entry?.default_url || '(not set)'}`);
  console.log(`Adapter:    ${entry?.adapter_path || baseline.source?.adapter_path}`);
  console.log(`Source:     ${(baseline.source?.source_files || []).join(', ')}`);
  console.log(`Health:     ${entry?.health || 'unknown'}`);
  console.log(`Last check: ${entry?.last_check || 'never'}`);

  console.log(`\n--- Roles (${Object.keys(baseline.roles).length}) ---`);
  for (const [name, role] of Object.entries(baseline.roles)) {
    const okCount = role.selectors.filter(s => s.status === 'ok').length;
    const brokenCount = role.selectors.filter(s => s.status === 'broken').length;
    const unknownCount = role.selectors.filter(s => s.status === 'unknown').length;
    const statusBar = [
      okCount ? `${okCount} ok` : '',
      brokenCount ? `${brokenCount} broken` : '',
      unknownCount ? `${unknownCount} unknown` : '',
    ].filter(Boolean).join(', ');

    console.log(`\n  [${role.category}] ${name}`);
    console.log(`  ${role.description}`);
    console.log(`  Selectors (${role.selectors.length}): ${statusBar}`);
    for (const sel of role.selectors) {
      const icon = sel.status === 'ok' ? '✓' : sel.status === 'broken' ? '✗' : '?';
      console.log(`    ${icon} ${sel.css} (p${sel.priority}, ${sel.stability})`);
    }
  }

  // Hints summary
  const hints = baseline.source?.analysis_hints;
  if (hints) {
    const active = Object.entries(hints).filter(([, v]) => v && (!Array.isArray(v) || v.length));
    console.log(`\n--- Analysis Hints (${active.length} active) ---`);
    for (const [key, value] of active) {
      const preview = Array.isArray(value) ? `[${value.length} items]` : typeof value === 'string' ? value.slice(0, 60) : JSON.stringify(value);
      console.log(`  ${key}: ${preview}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Subcommand: onboard — guided baseline creation for a new adapter
// ══════════════════════════════════════════════════════════════════════════════
function cmdOnboard(site) {
  const reg = loadRegistry();

  // Check if already onboarded
  if (reg.sites[site]) {
    console.log(`${site} already in registry. Use 'show' to view or 'check' to verify health.`);
    return;
  }

  // Check if adapter exists
  const adapterDir = resolve(process.env.HOME, '.npm-global/lib/node_modules/@jackwener/opencli/clis', site);
  if (!existsSync(adapterDir)) {
    console.error(`No adapter found at ~/.opencli/clis/${site}/ or ${adapterDir}`);
    console.error(`Available adapters: run 'ls ~/.npm-global/lib/node_modules/@jackwener/opencli/clis/'`);
    process.exit(1);
  }

  console.log(`\n=== dom-heal onboard: ${site} ===\n`);
  console.log(`Adapter found: ${adapterDir}`);

  // Discover source files
  const files = readdirSync(adapterDir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'test-utils.js');
  console.log(`Source files: ${files.join(', ')}`);

  // Extract selectors from each source file
  const selectorRegex = /querySelector(?:All)?\s*\(\s*(['"`])((?:(?!\1).)*)\1\s*\)/g;
  const allSelectors = new Set();
  const seen = new Set();

  for (const f of files) {
    const content = readFileSync(resolve(adapterDir, f), 'utf-8');
    for (const match of content.matchAll(selectorRegex)) {
      const raw = match[2];
      if (!raw || raw.length < 2 || raw.length > 300) continue;
      if (raw.startsWith('${') || raw.includes('${')) continue; // skip template interpolations
      if (seen.has(raw)) continue;
      seen.add(raw);
      allSelectors.add(raw);
    }

    // Also find selector arrays
    const arrayRegex = /(?:SELECTORS|selectors)\s*=\s*\[([\s\S]*?)\]/g;
    for (const m of content.matchAll(arrayRegex)) {
      const inner = m[1];
      for (const sm of inner.matchAll(/['"`]([^'"`]+)['"`]/g)) {
        const raw = sm[1];
        if (!raw || raw.length < 2 || raw.length > 300) continue;
        if (raw.startsWith('${')) continue;
        if (seen.has(raw)) continue;
        seen.add(raw);
        allSelectors.add(raw);
      }
    }
  }

  console.log(`\nExtracted ${allSelectors.size} candidate selectors:`);
  for (const sel of [...allSelectors].sort()) {
    console.log(`  ${sel}`);
  }

  console.log(`\n--- Next steps ---`);
  console.log(`1. Create baselines/${site}/selector-roles.json`);
  console.log(`   Categorize the selectors above into functional roles.`);
  console.log(`   Use 'node cli.mjs show doubao' for reference.`);
  console.log(`2. Validate: node -e "const {validateV2}=require('./lib/migrate.mjs'); console.log(validateV2(JSON.parse(require('fs').readFileSync('baselines/${site}/selector-roles.json','utf-8'))))"`);
  console.log(`3. Register: add entry to baselines/registry.json`);
  console.log(`4. Verify: node cli.mjs check ${site}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Subcommand: test — run the dom-heal test suite
// ══════════════════════════════════════════════════════════════════════════════
function cmdTest(args) {
  const watch = args.includes('--watch') ? '' : 'run';
  console.log(`\n=== dom-heal test ===\n`);
  try {
    execSync(`npx vitest ${watch}`, { stdio: 'inherit', cwd: SKILL_DIR });
  } catch {
    process.exitCode = 1;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Main dispatcher
// ══════════════════════════════════════════════════════════════════════════════
function printUsage() {
  console.log(`
dom-heal — DOM health maintenance CLI for OpenCLI browser adapters.

Usage:
  node cli.mjs <subcommand> [site] [options]

Subcommands:
  check     <site>          Health check against baseline
  diagnose  <site> [--role] Full analyze → compare → heal pipeline
  save      <site>          Snapshot + update baseline + update registry
  changes   <site>          Detect selector changes since last snapshot
  audit                     Batch health report across all sites
  show      <site>          Display baseline roles, selectors, and hints
  onboard   <site>          Guided baseline creation for a new adapter
  test      [--watch]       Run the dom-heal test suite

Options (check/diagnose/save/changes):
  --session <name>          Browser session name (default: same as site)

Examples:
  node cli.mjs check doubao
  node cli.mjs diagnose doubao --role send_button
  node cli.mjs save doubao
  node cli.mjs changes doubao
  node cli.mjs audit
  node cli.mjs show chatgpt
  node cli.mjs test --watch

Sites in registry: ${Object.keys(loadRegistry().sites).join(', ')}
`);
}

const args = process.argv.slice(2);
const subcommand = args[0];
const site = args[1];
const rest = args.slice(2);

switch (subcommand) {
  case 'check':
    if (!site) { console.error('Usage: cli.mjs check <site>'); process.exit(1); }
    cmdCheck(site, rest);
    break;
  case 'diagnose':
    if (!site) { console.error('Usage: cli.mjs diagnose <site> [--role <name>]'); process.exit(1); }
    cmdDiagnose(site, rest);
    break;
  case 'save':
    if (!site) { console.error('Usage: cli.mjs save <site>'); process.exit(1); }
    cmdSave(site, rest);
    break;
  case 'changes':
    if (!site) { console.error('Usage: cli.mjs changes <site>'); process.exit(1); }
    cmdChanges(site, rest);
    break;
  case 'audit':
    cmdAudit();
    break;
  case 'show':
    if (!site) { console.error('Usage: cli.mjs show <site>'); process.exit(1); }
    cmdShow(site);
    break;
  case 'onboard':
    if (!site) { console.error('Usage: cli.mjs onboard <site>'); process.exit(1); }
    cmdOnboard(site);
    break;
  case 'test':
    cmdTest(rest);
    break;
  case '--help':
  case '-h':
  case 'help':
    printUsage();
    break;
  default:
    console.error(`Unknown subcommand: ${subcommand || '(none)'}`);
    printUsage();
    process.exit(1);
}
