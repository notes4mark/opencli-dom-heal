/**
 * Baseline comparison engine.
 * Diffs a live DOM analysis snapshot against the stored baseline,
 * reporting selector drift, health status, and breakage by role.
 *
 * Usage:
 *   import { compareAnalysis } from './compare.mjs';
 *   const report = compareAnalysis(liveAnalysis, baseline);
 */

/**
 * Compare a live analysis snapshot against a stored baseline.
 * @param {object} liveAnalysis - Analysis output from the injected JS (snapshot format)
 * @param {object} baseline - The selector-roles.json baseline
 * @returns {object} Comparison report
 */
export function compareAnalysis(liveAnalysis, baseline) {
  const roles = {};
  let totalRoles = 0;
  let okRoles = 0;
  let degradedRoles = 0;
  let brokenRoles = 0;

  for (const [roleName, roleDef] of Object.entries(baseline.roles || {})) {
    totalRoles++;
    const baselineSelectors = roleDef.selectors || [];
    const selectorResults = [];

    for (const sel of baselineSelectors) {
      const liveCheck = findLiveSelectorStatus(liveAnalysis, sel.css);
      selectorResults.push({
        css: sel.css,
        type: sel.type,
        priority: sel.priority,
        stability: sel.stability,
        liveCount: liveCheck.count,
        liveFound: liveCheck.found,
        status: liveCheck.found ? 'ok' : 'missing'
      });
    }

    const working = selectorResults.filter(s => s.status === 'ok').length;
    const broken = selectorResults.length - working;

    let roleStatus;
    if (working === selectorResults.length && working > 0) {
      roleStatus = 'ok';
      okRoles++;
    } else if (working > 0) {
      roleStatus = 'degraded';
      degradedRoles++;
    } else if (selectorResults.length > 0) {
      roleStatus = 'broken';
      brokenRoles++;
    } else {
      roleStatus = 'no_selectors';
      brokenRoles++;
    }

    roles[roleName] = {
      description: roleDef.description,
      status: roleStatus,
      working: working,
      broken: broken,
      selectors: selectorResults
    };
  }

  // Detect new selectors not in the baseline
  const newSelectors = detectNewSelectors(liveAnalysis, baseline);

  // Overall health
  const overallStatus = brokenRoles > 0 ? 'critical' : degradedRoles > 0 ? 'degraded' : 'healthy';

  return {
    site: baseline.site,
    timestamp: new Date().toISOString(),
    liveUrl: liveAnalysis?.url || 'unknown',
    baselineVersion: baseline.schema_version || baseline.version || 1,
    baselineUpdated: baseline.updated,
    overallStatus,
    summary: {
      totalRoles,
      okRoles,
      degradedRoles,
      brokenRoles
    },
    roles,
    newSelectors,
    verificationDetected: liveAnalysis?.verification?.detected || false
  };
}

/**
 * Normalize CSS selector for comparison — standardizes quotes in attribute values.
 * Both `[class*="foo"]` and `[class*='foo']` are valid and equivalent.
 */
function normalizeCss(css) {
  if (!css) return '';
  return css.replace(/'/g, '"');
}

/**
 * Check if a specific CSS selector still matches elements in the live analysis.
 * Uses the health.role_checks data from the analysis output.
 */
function findLiveSelectorStatus(liveAnalysis, css) {
  if (!liveAnalysis || !liveAnalysis.health || !liveAnalysis.health.role_checks) {
    return scanCandidatesForSelector(liveAnalysis, css);
  }

  const normalizedCss = normalizeCss(css);

  const checks = liveAnalysis.health.role_checks;
  for (const [roleName, roleCheck] of Object.entries(checks)) {
    if (!roleCheck) continue;
    const details = roleCheck.details || [];
    const found = details.find(d => normalizeCss(d.css) === normalizedCss);
    if (found) {
      return { found: found.count > 0, count: found.count || 0 };
    }
    const inWorking = (roleCheck.working || []).find(w => normalizeCss(w.css) === normalizedCss);
    if (inWorking) return { found: true, count: inWorking.count || 1 };
    const inBroken = (roleCheck.broken || []).find(b => normalizeCss(b.css) === normalizedCss);
    if (inBroken) return { found: false, count: 0 };
  }

  return { found: false, count: 0, reason: 'selector not found in any role check' };
}

/**
 * Fallback: scan candidate arrays for a selector.
 */
function scanCandidatesForSelector(liveAnalysis, css) {
  if (!liveAnalysis || !liveAnalysis.candidates) return { found: false, count: 0 };

  for (const [category, items] of Object.entries(liveAnalysis.candidates)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item.css === css || item.selector === css || item.class === css) {
        return { found: true, count: 1 };
      }
    }
  }

  return { found: false, count: 0, reason: 'no match in candidates' };
}

/**
 * Detect selectors present in the live page that are not in the baseline.
 * This helps discover new selectors that could be used as replacements.
 */
function detectNewSelectors(liveAnalysis, baseline) {
  const newSels = {
    data_test_ids: [],
    id_selectors: [],
    class_prefixes: []
  };

  if (!liveAnalysis || !liveAnalysis.selectors) return newSels;

  const knownSelectors = new Set();
  if (baseline.roles) {
    for (const roleDef of Object.values(baseline.roles)) {
      for (const sel of (roleDef.selectors || [])) {
        knownSelectors.add(sel.css);
      }
    }
  }

  // Find new data-testid values
  if (liveAnalysis.selectors.data_test_ids) {
    for (const [testId, count] of Object.entries(liveAnalysis.selectors.data_test_ids)) {
      const css = `[data-testid="${testId}"]`;
      if (!knownSelectors.has(css)) {
        newSels.data_test_ids.push({ css, count });
      }
    }
  }

  // Find new IDs
  if (liveAnalysis.selectors.id_selectors) {
    for (const [id, count] of Object.entries(liveAnalysis.selectors.id_selectors)) {
      const css = `#${id}`;
      if (!knownSelectors.has(css)) {
        newSels.id_selectors.push({ css, count });
      }
    }
  }

  return newSels;
}

/**
 * Format a comparison report as a human-readable summary string.
 */
export function formatComparisonReport(report) {
  const lines = [];
  lines.push(`=== DOM Health Report: ${report.site} ===`);
  lines.push(`Overall: ${report.overallStatus.toUpperCase()}`);
  lines.push(`URL: ${report.liveUrl}`);
  lines.push(`Roles: ${report.summary.okRoles} ok / ${report.summary.degradedRoles} degraded / ${report.summary.brokenRoles} broken`);
  lines.push('');

  if (report.verificationDetected) {
    lines.push('WARNING: Verification/CAPTCHA detected on page! Analysis may be incomplete.');
    lines.push('');
  }

  for (const [roleName, roleReport] of Object.entries(report.roles)) {
    if (roleReport.status === 'ok') continue;
    const icon = roleReport.status === 'broken' ? 'BROKEN' : 'DEGRADED';
    lines.push(`[${icon}] ${roleName}: ${roleReport.description}`);
    for (const sel of roleReport.selectors) {
      const mark = sel.status === 'ok' ? 'OK' : 'MISSING';
      lines.push(`  ${mark} ${sel.css} (priority ${sel.priority}, ${sel.type})`);
    }
    lines.push('');
  }

  if (report.newSelectors && (report.newSelectors.data_test_ids.length > 0 || report.newSelectors.id_selectors.length > 0)) {
    lines.push('New selectors discovered (not in baseline):');
    for (const s of report.newSelectors.data_test_ids.slice(0, 10)) {
      lines.push(`  ${s.css} (count: ${s.count})`);
    }
    for (const s of report.newSelectors.id_selectors.slice(0, 5)) {
      lines.push(`  ${s.css} (count: ${s.count})`);
    }
  }

  return lines.join('\n');
}
