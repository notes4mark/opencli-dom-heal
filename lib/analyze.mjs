#!/usr/bin/env node

/**
 * CLI: DOM Analysis Tool
 * Injects analysis JS into a live browser page via opencli browser eval,
 * outputs structured JSON for comparison and healing.
 *
 * Also supports offline mode: analyze a frozen HTML fixture via JSDOM.
 *
 * Usage:
 *   # Analyze live doubao page (requires Chrome + opencli daemon)
 *   node scripts/dom-heal/analyze.mjs --site doubao
 *
 *   # Analyze frozen fixture (offline, for testing)
 *   node scripts/dom-heal/analyze.mjs --site doubao --fixture tests/dom-heal/fixtures/doubao-chat.html
 *
 *   # Compare live analysis against baseline
 *   node scripts/dom-heal/analyze.mjs --site doubao --compare
 *
 *   # Compare + save timestamped snapshot + update baseline status + update registry
 *   node scripts/dom-heal/analyze.mjs --site doubao --compare --save
 *
 *   # Detect changes against previous snapshot
 *   node scripts/dom-heal/analyze.mjs --site doubao --changes
 *
 *   # Save output to file
 *   node scripts/dom-heal/analyze.mjs --site doubao --output /tmp/snapshot.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { DOUBAO_ANALYZE_SCRIPT } from './analysis-doubao.js';
import { DEEPSEEK_ANALYZE_SCRIPT } from './analysis-deepseek.js';
import { compareAnalysis, formatComparisonReport } from './compare.mjs';
import { generateAnalysisScript } from './generate-analysis.mjs';
import { saveSnapshot, detectChanges, formatChangesReport, updateBaselineStatus, updateRegistry } from './snapshots.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
function resolveBaselinesDir() {
  if (process.env.DOM_HEAL_BASELINES) return process.env.DOM_HEAL_BASELINES;
  return join(__dirname, '..', 'baselines');
}
const BASELINES_DIR = resolveBaselinesDir();

// Hand-tuned scripts take priority (they have domain-specific heuristics)
const HAND_TUNED_SCRIPTS = {
  doubao: DOUBAO_ANALYZE_SCRIPT,
  deepseek: DEEPSEEK_ANALYZE_SCRIPT,
};

/**
 * Resolve the analysis script for a site.
 * Prefers hand-tuned scripts, falls back to generating from v2 baseline.
 */
function resolveScript(site) {
  if (HAND_TUNED_SCRIPTS[site]) {
    return { script: HAND_TUNED_SCRIPTS[site], source: 'hand-tuned' };
  }

  const baselinePath = join(BASELINES_DIR, site, 'selector-roles.json');
  if (existsSync(baselinePath)) {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    if (baseline.schema_version >= 2) {
      return { script: generateAnalysisScript(baseline), source: 'generated' };
    }
  }

  return null;
}

/**
 * Inject analysis JS into live browser page via opencli.
 * @param {string} site - Site name (doubao/deepseek)
 * @param {string} session - Browser session name
 */
async function analyzeLive(site, session) {
  const resolved = resolveScript(site);
  if (!resolved) {
    throw new Error(`Unknown site: ${site}. No hand-tuned script or v2 baseline found.`);
  }

  const { script, source } = resolved;
  const sessionName = session || site;

  // Pre-navigation for deepseek: capture main-page selectors first,
  // then navigate into a conversation for conversation-specific selectors.
  // .ds-message, .ds-markdown, .ds-think-content only exist in conversation view,
  // while model_radio only exists on the main page.
  let mainPageHealth = null;
  if (site === 'deepseek') {
    // Step 1: capture main-page-only roles (model_radio) before navigation
    const preScript = `() => {
      var result = {};
      try { result.model_radio = document.querySelectorAll('div[role="radio"]').length; } catch(e) { result.model_radio = 0; }
      result.hasMessages = document.querySelectorAll('.ds-message').length > 0;
      return JSON.stringify(result);
    }`;
    const preTmp = join(tmpdir(), `dom-heal-pre-${randomBytes(6).toString('hex')}.js`);
    writeFileSync(preTmp, preScript, 'utf-8');
    try {
      const preResult = execSync(
        `opencli browser ${sessionName} eval "$(cat '${preTmp}')"`,
        { encoding: 'utf-8', maxBuffer: 512 * 1024, timeout: 10000 }
      );
      mainPageHealth = JSON.parse(preResult.trim());
    } catch (e) {
      // ignore pre-check failures
    } finally {
      try { unlinkSync(preTmp); } catch {}
    }

    // Step 2: navigate into a conversation if needed
    if (mainPageHealth && !mainPageHealth.hasMessages) {
      const navScript = `async () => {
        // Poll for conversation links to appear (sidebar may lazy-load)
        let link = null;
        for (let i = 0; i < 20; i++) {
          link = document.querySelector('a[href*="/a/chat/s/"]');
          if (link) break;
          await new Promise(r => setTimeout(r, 500));
        }
        if (link) {
          // Click into existing conversation
          link.click();
        } else {
          // No existing conversations — start a new one by typing and sending
          const textarea = document.querySelector('textarea');
          if (!textarea) return 'no textarea to start conversation';
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(textarea, 'test');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 500));
          // Find and click the send button
          const btns = document.querySelectorAll('div[role="button"]');
          for (let i = btns.length - 1; i >= 0; i--) {
            if (btns[i].getAttribute('aria-disabled') !== 'true' && !btns[i].className.includes('toggle')) {
              btns[i].click();
              break;
            }
          }
        }
        // Poll for conversation content to load (wait for assistant response, not just user msg)
        for (let i = 0; i < 60; i++) {
          // Wait for markdown content (assistant response) to appear, indicating full response
          const hasMessages = document.querySelectorAll('.ds-message').length;
          const hasMarkdown = document.querySelector('.ds-markdown');
          if (hasMessages >= 2 && hasMarkdown) break;
          // If we only have the user message, keep waiting for response (up to 30s)
          await new Promise(r => setTimeout(r, 500));
        }
        const msgCount = document.querySelectorAll('.ds-message').length;
        const hasMd = !!document.querySelector('.ds-markdown');
        return hasMd ? 'navigated (' + msgCount + ' msgs with markdown)' : 'timeout: ' + msgCount + ' msgs, markdown=' + hasMd;
      }`;
      const navTmp = join(tmpdir(), `dom-heal-nav-${randomBytes(6).toString('hex')}.js`);
      writeFileSync(navTmp, navScript, 'utf-8');
      try {
        console.error('Navigating into conversation for selector analysis...');
        const navResult = execSync(
          `opencli browser ${sessionName} eval "$(cat '${navTmp}')"`,
          { encoding: 'utf-8', maxBuffer: 1024 * 1024, timeout: 45000 }
        );
        console.error(`  ${navResult.trim()}`);
      } catch (e) {
        console.error('  Navigation eval failed:', e.message);
      } finally {
        try { unlinkSync(navTmp); } catch {}
      }
    }
  }

  console.error(`Injecting analysis JS into ${site} (session: ${sessionName}, source: ${source})...`);

  // Write script to temp file to avoid shell escaping issues with quotes in JS
  const tmpPath = join(tmpdir(), `dom-heal-${randomBytes(6).toString('hex')}.js`);
  writeFileSync(tmpPath, script, 'utf-8');

  try {
    const result = execSync(
      `opencli browser ${sessionName} eval "$(cat '${tmpPath}')"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
    );

    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      // If the output isn't pure JSON, try to extract JSON from it
      const match = result.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error('Could not parse analysis output as JSON');
      }
    }

    // Merge main-page health data for roles that only exist on main page
    if (parsed && mainPageHealth) {
      if (!parsed.health) parsed.health = {};
      if (!parsed.health.role_checks) parsed.health.role_checks = {};
      // Restore model_radio from main page if it was broken after navigation
      if (mainPageHealth.model_radio > 0) {
        const modelCheck = parsed.health.role_checks.model_radio;
        if (!modelCheck || modelCheck.status === 'broken') {
          parsed.health.role_checks.model_radio = {
            working: [{ css: "div[role='radio']", count: mainPageHealth.model_radio }],
            broken: [],
            status: 'ok'
          };
        }
      }
    }

    return parsed;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

/**
 * Run analysis JS against a frozen HTML fixture using JSDOM (offline/testing mode).
 */
async function analyzeFixture(site, fixturePath) {
  const resolved = resolveScript(site);
  if (!resolved) {
    throw new Error(`Unknown site: ${site}. No hand-tuned script or v2 baseline found.`);
  }

  const { script, source } = resolved;
  console.error(`Analyzing fixture (source: ${source}): ${fixturePath}`);

  const { JSDOM } = await import('jsdom');
  const html = readFileSync(fixturePath, 'utf-8');
  const url = site === 'doubao' ? 'https://www.doubao.com/chat' : 'https://chat.deepseek.com';
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });

  // Polyfill innerText for JSDOM
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return this.textContent || ''; }
  });

  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 100, height: 24, top: 0, left: 0, right: 100, bottom: 24, x: 0, y: 0, toJSON: () => ({})
  });

  return dom.window.eval(`(${script})()`);
}

/**
 * Load baseline from file.
 */
function loadBaseline(site) {
  const baselinePath = join(BASELINES_DIR, site, 'selector-roles.json');
  if (!existsSync(baselinePath)) {
    throw new Error(`No baseline found for ${site} at ${baselinePath}`);
  }
  return JSON.parse(readFileSync(baselinePath, 'utf-8'));
}

/**
 * Run the full comparison pipeline: compare against baseline, update status,
 * save snapshot, update registry.
 */
function runComparisonPipeline(site, analysis, options = {}) {
  const { doSave = false, doUpdate = false } = options;
  const baselinePath = join(BASELINES_DIR, site, 'selector-roles.json');

  if (!existsSync(baselinePath)) {
    console.error(`No baseline found for ${site} at ${baselinePath}`);
    return null;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  const report = compareAnalysis(analysis, baseline);

  if (report) {
    // Save timestamped snapshot
    if (doSave) {
      const { path } = saveSnapshot(site, analysis);
      console.error(`Snapshot saved: ${path}`);
    }

    // Update baseline selector statuses and registry
    if (doUpdate) {
      const updated = updateBaselineStatus(baselinePath, report);
      if (updated) {
        console.error(`Baseline status updated: ${baselinePath}`);
      }
      updateRegistry(site, baseline, report);
      console.error(`Registry updated: ${BASELINES_DIR}/registry.json`);
    }
  }

  return report;
}

// CLI entry
async function main() {
  const args = process.argv.slice(2);

  const siteIdx = args.indexOf('--site');
  const fixtureIdx = args.indexOf('--fixture');
  const sessionIdx = args.indexOf('--session');
  const outputIdx = args.indexOf('--output');

  if (siteIdx === -1) {
    console.error('Usage: node analyze.mjs --site <doubao|deepseek> [--session <name>] [--fixture <path>] [--compare] [--changes] [--save] [--update] [--output <path>]');
    process.exit(1);
  }

  const site = args[siteIdx + 1];
  const session = sessionIdx !== -1 ? args[sessionIdx + 1] : null;
  const fixturePath = fixtureIdx !== -1 ? args[fixtureIdx + 1] : null;
  const doCompare = args.includes('--compare');
  const doChanges = args.includes('--changes');
  const doSave = args.includes('--save');
  const doUpdate = args.includes('--update');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;

  let analysis;
  if (fixturePath) {
    console.error(`Analyzing frozen fixture: ${fixturePath}`);
    analysis = await analyzeFixture(site, fixturePath);
  } else {
    analysis = await analyzeLive(site, session);
  }

  // Output the analysis JSON
  const jsonOutput = JSON.stringify(analysis, null, 2);

  if (outputPath) {
    writeFileSync(outputPath, jsonOutput, 'utf-8');
    console.error(`Analysis saved to: ${outputPath}`);
  }

  // Detect changes against previous snapshot
  if (doChanges) {
    const { loadLatestSnapshot } = await import('./snapshots.mjs');
    const prev = loadLatestSnapshot(site);
    if (prev) {
      const changes = detectChanges(prev, analysis);
      console.log(formatChangesReport(changes));
    } else {
      console.error('No previous snapshot found for change detection.');
    }
  }

  // Comparison pipeline
  if (doCompare) {
    const report = runComparisonPipeline(site, analysis, { doSave, doUpdate: doUpdate || doSave });
    if (report) {
      console.log(formatComparisonReport(report));
      if (report.overallStatus === 'critical') {
        process.exit(2);
      } else if (report.overallStatus === 'degraded') {
        process.exit(1);
      }
    }
  }

  // Always print JSON to stdout unless comparing or detecting changes
  if (!doCompare && !doChanges) {
    console.log(jsonOutput);
  }
}

main().catch(err => {
  console.error('Analysis failed:', err.message);
  process.exit(1);
});
