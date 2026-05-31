/**
 * Baseline schema migration: v1 → v2.
 *
 * v2 adds:
 *   - schema_version field
 *   - source block (adapter_path, extraction_method, source_files)
 *   - category on each role (button | input | container | link | content | indicator | interactive)
 *   - status + history on each selector
 *   - snapshots stub
 *   - _meta block for migration tracking
 *
 * Usage:
 *   node scripts/dom-heal/migrate.mjs --site doubao
 *   node scripts/dom-heal/migrate.mjs --site deepseek
 *   node scripts/dom-heal/migrate.mjs --all
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
function resolveBaselinesDir() {
  if (process.env.DOM_HEAL_BASELINES) return process.env.DOM_HEAL_BASELINES;
  return join(__dirname, '..', 'baselines');
}
const BASELINES_DIR = resolveBaselinesDir();

const ROLE_CATEGORIES = {
  composer_textarea: 'input',
  send_button: 'button',
  new_chat_button: 'button',
  message_list_container: 'container',
  message_item: 'container',
  meeting_card: 'container',
  sidebar_toggle: 'container',
  user_message: 'content',
  assistant_message: 'content',
  message_text: 'content',
  thinking_container: 'content',
  markdown_content: 'content',
  thinking_header: 'content',
  conversation_link: 'link',
  captcha_indicator: 'indicator',
  login_indicator: 'indicator',
  model_radio: 'interactive',
  feature_toggle: 'interactive',
};

function inferCategory(roleName) {
  if (ROLE_CATEGORIES[roleName]) return ROLE_CATEGORIES[roleName];
  if (roleName.includes('button')) return 'button';
  if (roleName.includes('input') || roleName.includes('textarea') || roleName.includes('composer')) return 'input';
  if (roleName.includes('link') || roleName.includes('href')) return 'link';
  if (roleName.includes('container') || roleName.includes('list') || roleName.includes('sidebar')) return 'container';
  if (roleName.includes('message') || roleName.includes('content') || roleName.includes('text') || roleName.includes('thinking')) return 'content';
  if (roleName.includes('captcha') || roleName.includes('verif') || roleName.includes('login') || roleName.includes('indicator')) return 'indicator';
  if (roleName.includes('toggle') || roleName.includes('radio') || roleName.includes('switch')) return 'interactive';
  return 'container';
}

/**
 * Migrate a v1 baseline to v2.
 * @param {object} v1 - The v1 baseline object
 * @returns {object} v2 baseline
 */
export function migrateV1toV2(v1) {
  const now = new Date().toISOString();
  const v2 = {
    schema_version: 2,
    site: v1.site,
    updated: now,
    source: {
      adapter_path: `~/.npm-global/lib/node_modules/@jackwener/opencli/clis/${v1.site}/`,
      source_files: ['utils.js'],
      extraction_method: 'manual',
      extraction_date: v1.updated || null,
    },
    roles: {},
    snapshots: {
      latest: null,
      history: [],
    },
    _meta: {
      migrated_from: 'v1',
      migrated_at: now,
      v1_version: v1.version || 1,
    },
  };

  for (const [roleName, roleDef] of Object.entries(v1.roles || {})) {
    const category = inferCategory(roleName);
    v2.roles[roleName] = {
      description: roleDef.description,
      category,
      selectors: (roleDef.selectors || []).map((sel) => ({
        css: sel.css,
        type: sel.type,
        priority: sel.priority,
        stability: sel.stability || 'medium',
        source: { file: v1.source_file || 'utils.js', extracted: v1.updated || null },
        status: 'unknown', // will be set by first health check
        history: [],
      })),
    };
  }

  return v2;
}

/**
 * Load baseline and detect its schema version.
 */
function detectVersion(baseline) {
  if (baseline.schema_version) return baseline.schema_version;
  return 1; // no schema_version field means v1
}

function loadBaseline(site) {
  const path = join(BASELINES_DIR, site, 'selector-roles.json');
  if (!existsSync(path)) {
    throw new Error(`Baseline not found for "${site}" at ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveBaseline(site, data) {
  const path = join(BASELINES_DIR, site, 'selector-roles.json');
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  return path;
}

/** Validate v2 baseline structure. */
export function validateV2(baseline) {
  const errors = [];
  if (baseline.schema_version !== 2) errors.push('schema_version must be 2');
  if (!baseline.site) errors.push('missing site');
  if (!baseline.source) errors.push('missing source block');
  if (!baseline.roles || typeof baseline.roles !== 'object') errors.push('missing roles');
  if (!baseline.snapshots) errors.push('missing snapshots');

  const validCategories = ['button', 'input', 'container', 'link', 'content', 'indicator', 'interactive'];
  for (const [roleName, role] of Object.entries(baseline.roles || {})) {
    if (!role.category) {
      errors.push(`role "${roleName}": missing category`);
    } else if (!validCategories.includes(role.category)) {
      errors.push(`role "${roleName}": invalid category "${role.category}"`);
    }
    if (!Array.isArray(role.selectors)) {
      errors.push(`role "${roleName}": selectors must be an array`);
    } else {
      for (let i = 0; i < role.selectors.length; i++) {
        const sel = role.selectors[i];
        if (!sel.css) errors.push(`role "${roleName}" selector[${i}]: missing css`);
        if (!sel.status) errors.push(`role "${roleName}" selector[${i}]: missing status`);
        if (!Array.isArray(sel.history)) errors.push(`role "${roleName}" selector[${i}]: history must be an array`);
      }
    }
  }
  return errors;
}

function main() {
  const args = process.argv.slice(2);
  const siteIdx = args.indexOf('--site');
  const allFlag = args.includes('--all');
  const dryRun = args.includes('--dry-run');

  if (!allFlag && siteIdx === -1) {
    console.error('Usage: node migrate.mjs --site <name> | --all [--dry-run]');
    process.exit(1);
  }

  const sites = allFlag
    ? ['doubao', 'deepseek']
    : [args[siteIdx + 1]];

  for (const site of sites) {
    const v1 = loadBaseline(site);
    const version = detectVersion(v1);

    if (version >= 2) {
      console.log(`${site}: already at v${version}, skipping`);
      continue;
    }

    console.log(`${site}: migrating v${version} → v2...`);
    const v2 = migrateV1toV2(v1);
    const errors = validateV2(v2);

    if (errors.length > 0) {
      console.error(`  Validation errors:`);
      for (const err of errors) console.error(`    - ${err}`);
      process.exit(1);
    }

    if (dryRun) {
      console.log(`  [dry-run] Would write ${JSON.stringify(v2, null, 2).length} bytes`);
    } else {
      const path = saveBaseline(site, v2);
      console.log(`  Wrote: ${path}`);
    }

    // Summary
    const roleCount = Object.keys(v2.roles).length;
    const selCount = Object.values(v2.roles).reduce((sum, r) => sum + r.selectors.length, 0);
    const categories = [...new Set(Object.values(v2.roles).map((r) => r.category))];
    console.log(`  ${roleCount} roles, ${selCount} selectors, categories: ${categories.join(', ')}`);
  }
}

{
  const isMain = process.argv[1] && (process.argv[1].endsWith('migrate.mjs') || process.argv[1].endsWith('migrate'));
  if (isMain) {
    try {
      main();
    } catch (err) {
      console.error('Migration failed:', err.message);
      process.exit(1);
    }
  }
}
