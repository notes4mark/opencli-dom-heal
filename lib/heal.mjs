/**
 * Self-healing engine — end-to-end pipeline.
 * Takes a live analysis snapshot + baseline, identifies broken roles,
 * ranks replacement candidates, and outputs structured fix suggestions.
 *
 * Usage:
 *   node scripts/dom-heal/heal.mjs --site doubao --analysis snapshot.json
 *   node scripts/dom-heal/heal.mjs --site doubao --role send_button --analysis snapshot.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareAnalysis, formatComparisonReport } from './compare.mjs';
import { recommendHeal } from './scorer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
function resolveBaselinesDir() {
  if (process.env.DOM_HEAL_BASELINES) return process.env.DOM_HEAL_BASELINES;
  return join(__dirname, '..', 'baselines');
}
const BASELINES_DIR = resolveBaselinesDir();

function loadBaseline(site) {
  const path = join(BASELINES_DIR, site, 'selector-roles.json');
  if (!existsSync(path)) {
    throw new Error(`Baseline not found for site "${site}" at ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function loadAnalysis(path) {
  if (!existsSync(path)) {
    throw new Error(`Analysis file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Run the full healing pipeline for a site.
 * @param {string} site - Site name (doubao, deepseek)
 * @param {object} analysis - Live DOM analysis output
 * @returns {object} Full heal report
 */
export function runHealPipeline(site, analysis) {
  const baseline = loadBaseline(site);

  // Phase 1: Compare live analysis against baseline
  const comparison = compareAnalysis(analysis, baseline);

  // Phase 2: For each broken/degraded role, find replacement candidates
  const healings = [];
  for (const [roleName, roleReport] of Object.entries(comparison.roles)) {
    if (roleReport.status === 'ok') continue;

    const roleDef = baseline.roles[roleName];
    const existingSelectors = roleDef ? roleDef.selectors : [];
    const recommendation = recommendHeal(analysis, roleName, existingSelectors);
    healings.push({
      role: roleName,
      status: roleReport.status,
      brokenSelectors: roleReport.selectors.filter(s => s.status === 'missing'),
      workingSelectors: roleReport.selectors.filter(s => s.status === 'ok'),
      recommendation
    });
  }

  return {
    site,
    timestamp: new Date().toISOString(),
    comparison,
    healings
  };
}

/**
 * Generate a human-readable healing report.
 */
export function formatHealReport(healResult) {
  const lines = [];
  lines.push(`=== Self-Healing Report: ${healResult.site} ===`);
  lines.push(`Time: ${healResult.timestamp}`);
  lines.push('');

  const comparison = healResult.comparison;
  lines.push(`Overall health: ${comparison.overallStatus.toUpperCase()}`);
  lines.push('');

  if (healResult.healings.length === 0) {
    lines.push('All roles are healthy. No healing needed.');
    return lines.join('\n');
  }

  for (const healing of healResult.healings) {
    const icon = healing.status === 'broken' ? 'BROKEN' : 'DEGRADED';
    lines.push(`--- ${icon}: ${healing.role} ---`);

    if (healing.brokenSelectors.length > 0) {
      lines.push('  Broken selectors:');
      for (const s of healing.brokenSelectors) {
        lines.push(`    - ${s.css} (priority ${s.priority})`);
      }
    }

    if (healing.workingSelectors.length > 0) {
      lines.push('  Still working:');
      for (const s of healing.workingSelectors) {
        lines.push(`    + ${s.css}`);
      }
    }

    const rec = healing.recommendation;
    if (rec.topCandidate) {
      lines.push(`  Top replacement candidate (score: ${rec.topCandidate.totalScore}):`);
      lines.push(`    CSS: ${rec.topCandidate.css}`);
      if (rec.topCandidate.breakdown) {
        const b = rec.topCandidate.breakdown;
        lines.push(`    Specificity: ${b.specificity?.type} (${b.specificity?.score})`);
        lines.push(`    Uniqueness: ${b.uniqueness?.label} (count=${b.uniqueness?.count}, score=${b.uniqueness?.score})`);
        if (b.textMatch?.score) lines.push(`    Text match: +${b.textMatch.score}`);
        if (b.historical?.score) lines.push(`    Historical: +${b.historical.score}`);
        if (b.hashedPenalty?.score) lines.push(`    Hashed penalty: ${b.hashedPenalty.score}`);
      }
    }

    if (rec.alternatives && rec.alternatives.length > 0) {
      lines.push('  Alternatives:');
      for (const alt of rec.alternatives) {
        lines.push(`    - ${alt.css} (score: ${alt.totalScore})`);
      }
    }

    if (!rec.topCandidate) {
      lines.push('  NO VIABLE CANDIDATES FOUND. Manual intervention needed.');
    }

    lines.push('');
  }

  return lines.join('\n');
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  const siteIdx = args.indexOf('--site');
  const analysisIdx = args.indexOf('--analysis');
  const roleIdx = args.indexOf('--role');
  const outputIdx = args.indexOf('--output');

  if (siteIdx === -1 || analysisIdx === -1) {
    console.error('Usage: node heal.mjs --site <doubao|deepseek> --analysis <path> [--role <name>] [--output <path>]');
    process.exit(1);
  }

  const site = args[siteIdx + 1];
  const analysisPath = args[analysisIdx + 1];
  const targetRole = roleIdx !== -1 ? args[roleIdx + 1] : null;
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;

  const analysis = loadAnalysis(analysisPath);
  const result = runHealPipeline(site, analysis);

  if (targetRole) {
    const healing = result.healings.find(h => h.role === targetRole);
    if (healing) {
      console.log(formatHealReport({
        site,
        timestamp: result.timestamp,
        comparison: result.comparison,
        healings: [healing]
      }));
    } else {
      console.log(`Role "${targetRole}" not found or is healthy.`);
    }
  } else {
    console.log(formatHealReport(result));
  }

  if (outputPath) {
    writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`Full report saved to: ${outputPath}`);
  }
}

main().catch(err => {
  console.error('Heal pipeline failed:', err.message);
  process.exit(1);
});
