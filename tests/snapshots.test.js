/**
 * Tests for snapshot management and change tracking.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  saveSnapshot,
  listSnapshots,
  loadSnapshot,
  loadLatestSnapshot,
  detectChanges,
  formatChangesReport,
  updateBaselineStatus,
  updateRegistry,
  pruneSnapshots
} from '../lib/snapshots.mjs';
import { compareAnalysis } from '../lib/compare.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Create a temporary test directory structure
function setupTestEnv() {
  const id = randomBytes(4).toString('hex');
  const testDir = join(tmpdir(), `dom-heal-test-${id}`);
  const baselinesDir = join(testDir, '.dom-baselines');
  const siteDir = join(baselinesDir, 'testsite');
  const snapshotsDir = join(siteDir, 'snapshots');

  // We need to mock BASELINES_DIR, but since it's hardcoded, we'll
  // instead work directly with the functions using controlled paths.
  // The functions use a hardcoded BASELINES_DIR relative to __dirname.
  // For testing, we test using the actual project baselines dir and
  // clean up after ourselves.

  return { testDir, baselinesDir, siteDir, snapshotsDir };
}

// Test the pure-logic functions (no filesystem dependency)
describe('detectChanges', () => {
  const prevAnalysis = {
    url: 'https://example.com',
    health: {
      role_checks: {
        send_button: {
          status: 'ok',
          working: [
            { css: 'button#send', count: 1 },
            { css: 'button[type="submit"]', count: 2 }
          ],
          broken: []
        },
        composer_textarea: {
          status: 'ok',
          working: [
            { css: 'textarea', count: 3 }
          ],
          broken: []
        }
      }
    }
  };

  it('detects no changes between identical analyses', () => {
    const changes = detectChanges(prevAnalysis, prevAnalysis);
    expect(changes.summary.totalChanges).toBe(0);
    expect(changes.appeared).toEqual([]);
    expect(changes.disappeared).toEqual([]);
    expect(changes.countChanged).toEqual([]);
  });

  it('detects disappeared selectors', () => {
    const curr = {
      health: {
        role_checks: {
          send_button: {
            status: 'degraded',
            working: [{ css: 'button[type="submit"]', count: 2 }],
            broken: [{ css: 'button#send', count: 0 }]
          },
          composer_textarea: {
            status: 'ok',
            working: [{ css: 'textarea', count: 3 }],
            broken: []
          }
        }
      }
    };

    const changes = detectChanges(prevAnalysis, curr);
    expect(changes.disappeared.length).toBe(1);
    expect(changes.disappeared[0]).toEqual({
      role: 'send_button',
      css: 'button#send',
      prevCount: 1,
      currCount: -1
    });
  });

  it('detects appeared selectors', () => {
    const curr = {
      health: {
        role_checks: {
          send_button: {
            status: 'ok',
            working: [
              { css: 'button#send', count: 1 },
              { css: 'button[type="submit"]', count: 2 },
              { css: 'button.new-btn', count: 1 }
            ],
            broken: []
          },
          composer_textarea: {
            status: 'ok',
            working: [{ css: 'textarea', count: 3 }],
            broken: []
          }
        }
      }
    };

    const changes = detectChanges(prevAnalysis, curr);
    expect(changes.appeared.length).toBe(1);
    expect(changes.appeared[0]).toEqual({
      role: 'send_button',
      css: 'button.new-btn',
      prevCount: -1,
      currCount: 1
    });
  });

  it('detects count changes', () => {
    const curr = {
      health: {
        role_checks: {
          send_button: {
            status: 'ok',
            working: [
              { css: 'button#send', count: 5 },
              { css: 'button[type="submit"]', count: 2 }
            ],
            broken: []
          },
          composer_textarea: {
            status: 'ok',
            working: [{ css: 'textarea', count: 3 }],
            broken: []
          }
        }
      }
    };

    const changes = detectChanges(prevAnalysis, curr);
    expect(changes.countChanged.length).toBe(1);
    expect(changes.countChanged[0]).toEqual({
      role: 'send_button',
      css: 'button#send',
      prevCount: 1,
      currCount: 5,
      delta: 4
    });
  });

  it('detects new roles that appeared', () => {
    const curr = {
      health: {
        role_checks: {
          ...prevAnalysis.health.role_checks,
          new_role: {
            status: 'ok',
            working: [{ css: '.new-selector', count: 1 }],
            broken: []
          }
        }
      }
    };

    const changes = detectChanges(prevAnalysis, curr);
    expect(changes.appeared.length).toBe(1);
    expect(changes.appeared[0].role).toBe('new_role');
    expect(changes.summary.rolesAffected).toBe(1);
  });

  it('detects disappeared roles', () => {
    const curr = {
      health: {
        role_checks: {
          send_button: prevAnalysis.health.role_checks.send_button
          // composer_textarea intentionally removed
        }
      }
    };

    const changes = detectChanges(prevAnalysis, curr);
    const disappearedRoles = changes.disappeared.filter(c => c.role === 'composer_textarea');
    expect(disappearedRoles.length).toBe(1);
  });

  it('handles null role checks gracefully', () => {
    const changes = detectChanges(null, prevAnalysis);
    expect(changes.appeared.length).toBeGreaterThan(0);
    expect(changes.summary.totalChanges).toBeGreaterThan(0);
  });
});

describe('formatChangesReport', () => {
  it('produces readable output for changes', () => {
    const changes = {
      appeared: [{ role: 'send_button', css: 'button.new', prevCount: -1, currCount: 1 }],
      disappeared: [{ role: 'send_button', css: 'button#old', prevCount: 1, currCount: -1 }],
      countChanged: [{ role: 'composer', css: 'textarea', prevCount: 1, currCount: 3, delta: 2 }],
      summary: { totalChanges: 3, appeared: 1, disappeared: 1, countChanged: 1, rolesAffected: 2 }
    };

    const report = formatChangesReport(changes);
    expect(report).toContain('Selector Changes');
    expect(report).toContain('DISAPPEARED');
    expect(report).toContain('APPEARED');
    expect(report).toContain('COUNT CHANGED');
    expect(report).toContain('button#old');
    expect(report).toContain('button.new');
    expect(report).toContain('+2');
  });
});

describe('snapshot lifecycle', () => {
  const testSite = `test-snapshots-${randomBytes(4).toString('hex')}`;
  const baselinesDir = join(__dirname, '..', 'baselines');
  const siteDir = join(baselinesDir, testSite);

  function makeAnalysis(overrides = {}) {
    return {
      url: 'https://example.com/chat',
      timestamp: new Date().toISOString(),
      layout: {},
      selectors: {
        data_test_ids: { 'btn': 1 },
        data_attributes: ['data-testid'],
        id_selectors: { 'main': 1 },
        class_prefixes: { 'container': 5 }
      },
      candidates: {
        text_inputs: [{ css: 'textarea', count: 1 }],
        buttons: [{ css: 'button#send', count: 1 }],
        scroll_containers: [],
        message_blocks: [],
        links: []
      },
      health: {
        role_checks: {
          send_button: {
            status: 'ok',
            working: [{ css: 'button#send', count: 1 }],
            broken: []
          },
          composer_textarea: {
            status: 'ok',
            working: [{ css: 'textarea', count: 1 }],
            broken: []
          }
        }
      },
      ...overrides
    };
  }

  function makeBaseline() {
    return {
      schema_version: 2,
      site: testSite,
      updated: new Date().toISOString(),
      source: {
        adapter_path: '/tmp/test/',
        source_files: ['utils.js'],
        extraction_method: 'manual',
        extraction_date: '2026-01-01T00:00:00Z'
      },
      roles: {
        send_button: {
          description: 'Send button',
          category: 'button',
          selectors: [
            { css: 'button#send', type: 'id', priority: 1, stability: 'medium', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] }
          ]
        },
        composer_textarea: {
          description: 'Input',
          category: 'input',
          selectors: [
            { css: 'textarea', type: 'tag', priority: 1, stability: 'high', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] }
          ]
        }
      },
      snapshots: { latest: null, history: [] }
    };
  }

  beforeEach(() => {
    // Clean up any leftover test data
    try { rmSync(siteDir, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => {
    try { rmSync(siteDir, { recursive: true, force: true }); } catch {}
  });

  it('saveSnapshot creates a timestamped JSON file', () => {
    // Create a minimal baseline first so updateLatestRef works
    const baseline = makeBaseline();
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(join(siteDir, 'selector-roles.json'), JSON.stringify(baseline, null, 2), 'utf-8');

    const { path, timestamp } = saveSnapshot(testSite, makeAnalysis());

    expect(existsSync(path)).toBe(true);
    const loaded = JSON.parse(readFileSync(path, 'utf-8'));
    expect(loaded.url).toBe('https://example.com/chat');

    // Verify baseline was updated
    const updatedBaseline = JSON.parse(readFileSync(join(siteDir, 'selector-roles.json'), 'utf-8'));
    expect(updatedBaseline.snapshots.latest).toBeDefined();
    expect(updatedBaseline.snapshots.history).toContain(updatedBaseline.snapshots.latest);
  });

  it('listSnapshots returns snapshots sorted newest first', () => {
    const baseline = makeBaseline();
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(join(siteDir, 'selector-roles.json'), JSON.stringify(baseline, null, 2), 'utf-8');

    saveSnapshot(testSite, makeAnalysis({ url: 'first' }));
    // Small delay to ensure different timestamps
    saveSnapshot(testSite, makeAnalysis({ url: 'second' }));

    const list = listSnapshots(testSite);
    expect(list.length).toBe(2);
    // Newest first
    expect(list[0].url).toBe('second');
    expect(list[1].url).toBe('first');
  });

  it('loadSnapshot loads by filename', () => {
    const baseline = makeBaseline();
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(join(siteDir, 'selector-roles.json'), JSON.stringify(baseline, null, 2), 'utf-8');

    const { path } = saveSnapshot(testSite, makeAnalysis({ url: 'test-url' }));
    const filename = path.split('/').pop();

    const loaded = loadSnapshot(testSite, filename);
    expect(loaded).toBeDefined();
    expect(loaded.url).toBe('test-url');
  });

  it('loadLatestSnapshot returns the most recent snapshot', () => {
    const baseline = makeBaseline();
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(join(siteDir, 'selector-roles.json'), JSON.stringify(baseline, null, 2), 'utf-8');

    saveSnapshot(testSite, makeAnalysis({ url: 'latest' }));

    const loaded = loadLatestSnapshot(testSite);
    expect(loaded).toBeDefined();
    expect(loaded.url).toBe('latest');
  });

  it('pruneSnapshots removes oldest snapshots beyond limit', () => {
    const baseline = makeBaseline();
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(join(siteDir, 'selector-roles.json'), JSON.stringify(baseline, null, 2), 'utf-8');

    // Save 5 snapshots with max 3
    for (let i = 0; i < 5; i++) {
      saveSnapshot(testSite, makeAnalysis({ url: `snap-${i}` }), { maxSnapshots: 3 });
    }

    const list = listSnapshots(testSite);
    expect(list.length).toBeLessThanOrEqual(3);
  });
});

describe('updateBaselineStatus', () => {
  const testSite = `test-status-${randomBytes(4).toString('hex')}`;
  const baselinesDir = join(__dirname, '..', 'baselines');
  const siteDir = join(baselinesDir, testSite);

  function makeBaseline() {
    return {
      schema_version: 2,
      site: testSite,
      updated: '2026-01-01T00:00:00Z',
      source: {
        adapter_path: '/tmp/test/',
        source_files: ['utils.js'],
        extraction_method: 'manual',
        extraction_date: '2026-01-01T00:00:00Z'
      },
      roles: {
        send_button: {
          description: 'Send button',
          category: 'button',
          selectors: [
            { css: 'button#send', type: 'id', priority: 1, stability: 'low', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] },
            { css: 'button[type="submit"]', type: 'attribute', priority: 2, stability: 'high', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] }
          ]
        }
      },
      snapshots: { latest: null, history: [] }
    };
  }

  beforeEach(() => {
    try { rmSync(siteDir, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => {
    try { rmSync(siteDir, { recursive: true, force: true }); } catch {}
  });

  it('updates selector status from ok to broken when selector disappears', () => {
    const baseline = makeBaseline();
    mkdirSync(siteDir, { recursive: true });
    const baselinePath = join(siteDir, 'selector-roles.json');
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');

    // Simulate a report where the first selector is missing
    const report = {
      roles: {
        send_button: {
          status: 'degraded',
          selectors: [
            { css: 'button#send', status: 'missing', liveCount: 0 },
            { css: 'button[type="submit"]', status: 'ok', liveCount: 1 }
          ]
        }
      }
    };

    const result = updateBaselineStatus(baselinePath, report);
    expect(result).toBe(true);

    const updated = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    const selectors = updated.roles.send_button.selectors;

    const brokenSel = selectors.find(s => s.css === 'button#send');
    expect(brokenSel.status).toBe('broken');
    expect(brokenSel.history.length).toBe(1);
    expect(brokenSel.history[0].status).toBe('broken');
  });

  it('updates selector status from unknown to ok', () => {
    const baseline = makeBaseline();
    mkdirSync(siteDir, { recursive: true });
    const baselinePath = join(siteDir, 'selector-roles.json');
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');

    const report = {
      roles: {
        send_button: {
          status: 'ok',
          selectors: [
            { css: 'button#send', status: 'ok', liveCount: 1 },
            { css: 'button[type="submit"]', status: 'ok', liveCount: 2 }
          ]
        }
      }
    };

    updateBaselineStatus(baselinePath, report);

    const updated = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    const selectors = updated.roles.send_button.selectors;

    expect(selectors[0].status).toBe('ok');
    expect(selectors[0].history.length).toBe(1);
    expect(selectors[0].history[0].status).toBe('ok');
  });

  it('does not duplicate history when status unchanged (same day)', () => {
    const baseline = makeBaseline();
    // Pre-set status to ok
    baseline.roles.send_button.selectors[0].status = 'ok';
    baseline.roles.send_button.selectors[0].history = [
      { timestamp: new Date().toISOString(), status: 'ok', count: 1 }
    ];

    mkdirSync(siteDir, { recursive: true });
    const baselinePath = join(siteDir, 'selector-roles.json');
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');

    const report = {
      roles: {
        send_button: {
          status: 'ok',
          selectors: [
            { css: 'button#send', status: 'ok', liveCount: 1 }
          ]
        }
      }
    };

    updateBaselineStatus(baselinePath, report);

    const updated = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    // Should still have only 1 history entry (throttled)
    expect(updated.roles.send_button.selectors[0].history.length).toBe(1);
  });

  it('handles missing baseline path gracefully', () => {
    const result = updateBaselineStatus('/nonexistent/path.json', {});
    expect(result).toBe(false);
  });
});

describe('updateRegistry', () => {
  const testSite = `test-registry-${randomBytes(4).toString('hex')}`;
  const baselinesDir = join(__dirname, '..', 'baselines');
  const siteDir = join(baselinesDir, testSite);
  const registryPath = join(baselinesDir, 'registry.json');

  // Back up existing registry
  let registryBackup = null;

  beforeEach(() => {
    if (existsSync(registryPath)) {
      registryBackup = readFileSync(registryPath, 'utf-8');
    }
    try { rmSync(siteDir, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => {
    if (registryBackup) {
      writeFileSync(registryPath, registryBackup, 'utf-8');
    }
    try { rmSync(siteDir, { recursive: true, force: true }); } catch {}
  });

  it('adds a new site entry to registry', () => {
    const baseline = {
      schema_version: 2,
      site: testSite,
      roles: {
        send_button: {
          category: 'button',
          selectors: [{ css: 'button', type: 'tag', priority: 1 }]
        },
        composer: {
          category: 'input',
          selectors: [{ css: 'textarea', type: 'tag', priority: 1 }]
        }
      }
    };

    const report = {
      overallStatus: 'degraded',
      roles: {
        send_button: { status: 'ok' },
        composer: { status: 'broken' }
      }
    };

    const registry = updateRegistry(testSite, baseline, report);

    expect(registry.sites[testSite]).toBeDefined();
    expect(registry.sites[testSite].health).toBe('degraded');
    expect(registry.sites[testSite].broken_roles).toEqual(['composer']);
    expect(registry.sites[testSite].role_count).toBe(2);
    expect(registry.sites[testSite].selector_count).toBe(2);
    expect(registry.sites[testSite].categories).toContain('button');
    expect(registry.sites[testSite].categories).toContain('input');
    expect(registry.sites[testSite].last_check).toBeDefined();
  });

  it('updates existing site entry', () => {
    const baseline = {
      schema_version: 2,
      site: testSite,
      roles: {
        test_role: {
          category: 'container',
          selectors: [{ css: 'div', type: 'tag', priority: 1 }]
        }
      }
    };

    const report = { overallStatus: 'healthy', roles: { test_role: { status: 'ok' } } };

    // First write
    updateRegistry(testSite, baseline, report);
    // Second write should update
    const report2 = { overallStatus: 'critical', roles: { test_role: { status: 'broken' } } };
    const registry = updateRegistry(testSite, baseline, report2);

    expect(registry.sites[testSite].health).toBe('critical');
    expect(registry.sites[testSite].broken_roles).toEqual(['test_role']);
  });

  it('handles null report for unknown health', () => {
    const baseline = {
      schema_version: 2,
      site: testSite,
      roles: {}
    };

    const registry = updateRegistry(testSite, baseline, null);
    expect(registry.sites[testSite].health).toBe('unknown');
    expect(registry.sites[testSite].broken_roles).toBeUndefined();
  });
});

describe('integration: comparison → status update', () => {
  const testSite = `test-integ-${randomBytes(4).toString('hex')}`;
  const baselinesDir = join(__dirname, '..', 'baselines');
  const siteDir = join(baselinesDir, testSite);

  beforeEach(() => {
    try { rmSync(siteDir, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => {
    try { rmSync(siteDir, { recursive: true, force: true }); } catch {}
  });

  it('end-to-end: analysis → compare → update status → registry', () => {
    const baseline = {
      schema_version: 2,
      site: testSite,
      updated: '2026-01-01T00:00:00Z',
      source: { adapter_path: '/tmp/', source_files: ['utils.js'], extraction_method: 'manual', extraction_date: '2026-01-01T00:00:00Z' },
      roles: {
        send_button: {
          description: 'Send',
          category: 'button',
          selectors: [
            { css: 'button#send', type: 'id', priority: 1, stability: 'low', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] }
          ]
        }
      },
      snapshots: { latest: null, history: [] }
    };

    mkdirSync(siteDir, { recursive: true });
    const baselinePath = join(siteDir, 'selector-roles.json');
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');

    // Simulate an analysis where the selector is missing
    const analysis = {
      url: 'https://example.com',
      health: {
        role_checks: {
          send_button: {
            status: 'broken',
            working: [],
            broken: [{ css: 'button#send', count: 0 }]
          }
        }
      }
    };

    // Run comparison
    const report = compareAnalysis(analysis, baseline);
    expect(report.overallStatus).toBe('critical');
    expect(report.roles.send_button.status).toBe('broken');

    // Update baseline status
    const updated = updateBaselineStatus(baselinePath, report);
    expect(updated).toBe(true);

    // Verify status was written
    const reloaded = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    const sel = reloaded.roles.send_button.selectors[0];
    expect(sel.status).toBe('broken');
    expect(sel.history.length).toBe(1);

    // Update registry
    const registry = updateRegistry(testSite, reloaded, report);
    expect(registry.sites[testSite].health).toBe('critical');
    expect(registry.sites[testSite].broken_roles).toEqual(['send_button']);
  });
});
