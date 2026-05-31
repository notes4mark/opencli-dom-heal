/**
 * Snapshot management and change history tracking.
 *
 * Records DOM analysis snapshots over time, detects selector drift between
 * consecutive runs, and keeps baseline selector status/history up to date.
 *
 * Usage:
 *   import { saveSnapshot, updateBaselineStatus, updateRegistry } from './snapshots.mjs';
 *   const { path } = saveSnapshot('doubao', analysis);
 *   updateBaselineStatus(baselinePath, report);
 *   updateRegistry('doubao', baseline, report);
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
function resolveBaselinesDir() {
  if (process.env.DOM_HEAL_BASELINES) return process.env.DOM_HEAL_BASELINES;
  return join(__dirname, '..', 'baselines');
}
const BASELINES_DIR = resolveBaselinesDir();

/**
 * Ensure snapshots directory exists for a site.
 */
function snapshotsDir(site) {
  const dir = join(BASELINES_DIR, site, 'snapshots');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Save an analysis result as a timestamped snapshot.
 * @param {string} site - Site name
 * @param {object} analysis - Analysis output (snapshot format)
 * @param {object} options
 * @param {number} options.maxSnapshots - Max snapshots to keep (default 10)
 * @returns {{ path: string, timestamp: string }}
 */
let _snapshotSeq = 0;

export function saveSnapshot(site, analysis, options = {}) {
  const { maxSnapshots = 10 } = options;
  const dir = snapshotsDir(site);
  // Use sub-millisecond sequence to avoid overwrites within the same instant
  const ts = Date.now();
  const seq = ++_snapshotSeq;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}-${String(seq).padStart(4, '0')}.json`;
  const path = join(dir, filename);

  // Strip heavy candidate details for storage efficiency, keep structure
  const slim = slimAnalysis(analysis);
  writeFileSync(path, JSON.stringify(slim, null, 2), 'utf-8');

  // Update latest symlink-like reference in baseline
  updateLatestRef(site, filename);

  // Prune old snapshots
  pruneSnapshots(site, maxSnapshots);

  return { path, timestamp };
}

/**
 * Reduce analysis size by truncating verbose candidate fields.
 * Keeps health checks and selector catalogs intact.
 */
function slimAnalysis(analysis) {
  if (!analysis) return analysis;
  const slim = { ...analysis };

  // Keep selectors intact — they're needed for change detection
  // Truncate candidate arrays to keep storage manageable
  if (slim.candidates) {
    slim.candidates = {
      text_inputs: (slim.candidates.text_inputs || []).slice(0, 20),
      buttons: (slim.candidates.buttons || []).slice(0, 30),
      scroll_containers: (slim.candidates.scroll_containers || []).slice(0, 10),
      message_blocks: (slim.candidates.message_blocks || []).slice(0, 20),
      links: (slim.candidates.links || []).slice(0, 20)
    };
  }

  return slim;
}

/**
 * Update the baseline's snapshots.latest reference.
 */
function updateLatestRef(site, filename) {
  const baselinePath = join(BASELINES_DIR, site, 'selector-roles.json');
  if (!existsSync(baselinePath)) return;

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  if (!baseline.snapshots) {
    baseline.snapshots = { latest: null, history: [] };
  }
  baseline.snapshots.latest = filename;

  // Add to history if not already present
  if (!baseline.snapshots.history.includes(filename)) {
    baseline.snapshots.history.push(filename);
    // Keep last 20 entries
    if (baseline.snapshots.history.length > 20) {
      baseline.snapshots.history = baseline.snapshots.history.slice(-20);
    }
  }

  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
}

/**
 * List all snapshots for a site, sorted by timestamp (newest first).
 * @returns {Array<{ timestamp: string, filename: string, path: string, url: string, summary: object }>}
 */
export function listSnapshots(site) {
  const dir = join(BASELINES_DIR, site, 'snapshots');
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .map(filename => {
      const path = join(dir, filename);
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      return {
        timestamp: data.timestamp || filename.replace('.json', ''),
        filename,
        path,
        url: data.url || 'unknown',
        summary: summarizeAnalysis(data)
      };
    });
}

/**
 * Load a specific snapshot by filename or ISO-like timestamp.
 */
export function loadSnapshot(site, identifier) {
  const dir = join(BASELINES_DIR, site, 'snapshots');
  const filename = identifier.endsWith('.json') ? identifier : `${identifier}.json`;
  const path = join(dir, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Load the latest snapshot for a site.
 */
export function loadLatestSnapshot(site) {
  const baselinePath = join(BASELINES_DIR, site, 'selector-roles.json');
  if (!existsSync(baselinePath)) return null;

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  const latest = baseline.snapshots?.latest;
  if (!latest) return null;

  return loadSnapshot(site, latest);
}

/**
 * Quick summary from analysis data.
 */
function summarizeAnalysis(analysis) {
  if (!analysis || !analysis.health || !analysis.health.role_checks) {
    return { totalRoles: 0, okRoles: 0, degradedRoles: 0, brokenRoles: 0 };
  }

  let ok = 0, degraded = 0, broken = 0;
  for (const check of Object.values(analysis.health.role_checks)) {
    if (!check) continue;
    if (check.status === 'ok') ok++;
    else if (check.status === 'degraded') degraded++;
    else broken++;
  }

  return { totalRoles: ok + degraded + broken, okRoles: ok, degradedRoles: degraded, brokenRoles: broken };
}

/**
 * Detect selector-level changes between two analyses.
 * Compares role_checks to find newly appeared, disappeared, or count-changed selectors.
 *
 * @param {object} prevAnalysis - Previous analysis snapshot
 * @param {object} currAnalysis - Current analysis snapshot
 * @returns {{ appeared: object[], disappeared: object[], countChanged: object[], summary: object }}
 */
export function detectChanges(prevAnalysis, currAnalysis) {
  const appeared = [];
  const disappeared = [];
  const countChanged = [];

  const prevChecks = prevAnalysis?.health?.role_checks || {};
  const currChecks = currAnalysis?.health?.role_checks || {};

  const allRoles = new Set([...Object.keys(prevChecks), ...Object.keys(currChecks)]);

  for (const roleName of allRoles) {
    const prevRole = prevChecks[roleName];
    const currRole = currChecks[roleName];

    // Collect all selectors from both snapshots for this role
    const prevSelectors = collectSelectorCounts(prevRole);
    const currSelectors = collectSelectorCounts(currRole);

    const allSels = new Set([...Object.keys(prevSelectors), ...Object.keys(currSelectors)]);

    for (const css of allSels) {
      const prevCount = prevSelectors[css] ?? -1;
      const currCount = currSelectors[css] ?? -1;

      if (prevCount < 0 && currCount >= 0) {
        appeared.push({ role: roleName, css, prevCount, currCount });
      } else if (prevCount >= 0 && currCount < 0) {
        disappeared.push({ role: roleName, css, prevCount, currCount });
      } else if (prevCount !== currCount) {
        countChanged.push({ role: roleName, css, prevCount, currCount, delta: currCount - prevCount });
      }
    }
  }

  return {
    appeared,
    disappeared,
    countChanged,
    summary: {
      totalChanges: appeared.length + disappeared.length + countChanged.length,
      appeared: appeared.length,
      disappeared: disappeared.length,
      countChanged: countChanged.length,
      rolesAffected: new Set([
        ...appeared.map(c => c.role),
        ...disappeared.map(c => c.role),
        ...countChanged.map(c => c.role)
      ]).size
    }
  };
}

/**
 * Collect selector→count mapping from a role check object.
 */
function collectSelectorCounts(roleCheck) {
  const map = {};
  if (!roleCheck) return map;

  const working = roleCheck.working || [];
  const broken = roleCheck.broken || [];

  for (const w of working) {
    if (w.css && w.count > 0) map[w.css] = w.count;
  }
  // Only include broken selectors with actual count (not 0 = absent)
  for (const b of broken) {
    if (b.css && b.count > 0 && !(b.css in map)) map[b.css] = b.count;
  }

  return map;
}

/**
 * Update baseline selector statuses and history from a comparison report.
 * Reads the baseline, updates each selector's status field and pushes
 * a history entry, then writes back.
 *
 * @param {string} baselinePath - Path to selector-roles.json
 * @param {object} report - Output from compareAnalysis()
 */
export function updateBaselineStatus(baselinePath, report) {
  if (!existsSync(baselinePath)) return false;

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  const now = new Date().toISOString();

  for (const [roleName, roleReport] of Object.entries(report.roles || {})) {
    const roleDef = baseline.roles?.[roleName];
    if (!roleDef) continue;

    for (const selReport of roleReport.selectors || []) {
      const selDef = (roleDef.selectors || []).find(s => s.css === selReport.css);
      if (!selDef) continue;

      const newStatus = selReport.status === 'ok' ? 'ok' : 'broken';

      // Only push history if status changed
      if (selDef.status !== newStatus) {
        if (!Array.isArray(selDef.history)) selDef.history = [];
        selDef.history.push({
          timestamp: now,
          status: newStatus,
          count: selReport.liveCount || 0
        });
        selDef.status = newStatus;
      } else if (selDef.status === 'ok') {
        // Still record periodic OK checks (but throttle: only if last entry is older than 1 day)
        const lastEntry = (selDef.history || []).slice(-1)[0];
        if (!lastEntry || (new Date(now) - new Date(lastEntry.timestamp)) > 86400000) {
          if (!Array.isArray(selDef.history)) selDef.history = [];
          selDef.history.push({
            timestamp: now,
            status: 'ok',
            count: selReport.liveCount || 0
          });
        }
      }
    }
  }

  baseline.updated = now;
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
  return true;
}

/**
 * Update registry.json with the latest health status for a site.
 *
 * @param {string} site - Site name
 * @param {object} baseline - The baseline object (or path string)
 * @param {object} report - Comparison report (or null to just refresh metadata)
 */
export function updateRegistry(site, baseline, report) {
  const registryPath = join(BASELINES_DIR, 'registry.json');
  const registry = existsSync(registryPath)
    ? JSON.parse(readFileSync(registryPath, 'utf-8'))
    : { schema_version: 1, updated: new Date().toISOString(), sites: {} };

  // Allow passing baseline path string
  const baselineObj = typeof baseline === 'string'
    ? JSON.parse(readFileSync(baseline, 'utf-8'))
    : baseline;

  if (!registry.sites) registry.sites = {};
  if (!registry.sites[site]) {
    registry.sites[site] = {};
  }

  const entry = registry.sites[site];
  entry.baseline_version = baselineObj.schema_version || baselineObj.version || 1;
  entry.selector_count = Object.values(baselineObj.roles || {}).reduce((sum, r) => sum + (r.selectors || []).length, 0);
  entry.role_count = Object.keys(baselineObj.roles || {}).length;
  entry.last_check = new Date().toISOString();

  if (report) {
    entry.health = report.overallStatus;
    entry.broken_roles = Object.entries(report.roles || {})
      .filter(([, r]) => r.status === 'broken')
      .map(([name]) => name);
    entry.degraded_roles = Object.entries(report.roles || {})
      .filter(([, r]) => r.status === 'degraded')
      .map(([name]) => name);
  } else {
    entry.health = 'unknown';
  }

  const categories = new Set();
  for (const role of Object.values(baselineObj.roles || {})) {
    if (role.category) categories.add(role.category);
  }
  entry.categories = Array.from(categories).sort();

  registry.updated = new Date().toISOString();
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  return registry;
}

/**
 * Prune old snapshots beyond the limit.
 */
export function pruneSnapshots(site, maxSnapshots = 10) {
  const dir = join(BASELINES_DIR, site, 'snapshots');
  if (!existsSync(dir)) return;

  const snapshots = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort(); // oldest first

  while (snapshots.length > maxSnapshots) {
    const oldest = snapshots.shift();
    try {
      unlinkSync(join(dir, oldest));
    } catch {
      // Ignore deletion failures
    }
  }
}

/**
 * Format a change detection result as a human-readable summary.
 */
export function formatChangesReport(changes) {
  const lines = [];
  lines.push('=== Selector Changes Detected ===');
  lines.push(`Total changes: ${changes.summary.totalChanges} (${changes.summary.appeared} appeared, ${changes.summary.disappeared} disappeared, ${changes.summary.countChanged} count changes)`);
  lines.push(`Roles affected: ${changes.summary.rolesAffected}`);
  lines.push('');

  if (changes.disappeared.length > 0) {
    lines.push('--- DISAPPEARED ---');
    for (const d of changes.disappeared) {
      lines.push(`  [${d.role}] ${d.css} (was ${d.prevCount})`);
    }
    lines.push('');
  }

  if (changes.appeared.length > 0) {
    lines.push('--- APPEARED ---');
    for (const a of changes.appeared) {
      lines.push(`  [${a.role}] ${a.css} (now ${a.currCount})`);
    }
    lines.push('');
  }

  if (changes.countChanged.length > 0) {
    lines.push('--- COUNT CHANGED ---');
    for (const c of changes.countChanged) {
      const sign = c.delta > 0 ? '+' : '';
      lines.push(`  [${c.role}] ${c.css}: ${c.prevCount} → ${c.currCount} (${sign}${c.delta})`);
    }
  }

  return lines.join('\n');
}
