/**
 * cli.mjs integration tests — verify subcommands work without a browser.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve(__dirname, '..', 'cli.mjs');

function run(...args) {
  try {
    const out = execSync(`node "${CLI}" ${args.join(' ')}`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 30000,
    });
    return { stdout: out, stderr: '', exitCode: 0 };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status || 1 };
  }
}

describe('cli.mjs', () => {
  describe('--help', () => {
    it('prints usage with all subcommands', () => {
      const { stdout, exitCode } = run('--help');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('check');
      expect(stdout).toContain('diagnose');
      expect(stdout).toContain('save');
      expect(stdout).toContain('changes');
      expect(stdout).toContain('audit');
      expect(stdout).toContain('show');
      expect(stdout).toContain('onboard');
      expect(stdout).toContain('test');
    });

    it('prints registered sites', () => {
      const { stdout } = run('--help');
      expect(stdout).toContain('doubao');
      expect(stdout).toContain('deepseek');
      expect(stdout).toContain('chatgpt');
      expect(stdout).toContain('claude');
      expect(stdout).toContain('xiaohongshu');
      expect(stdout).toContain('boss');
    });
  });

  describe('unknown subcommand', () => {
    it('exits with error and shows usage', () => {
      const { stderr, exitCode } = run('nonexistent');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown subcommand');
    });
  });

  describe('show', () => {
    it('displays baseline info for chatgpt', () => {
      const { stdout, exitCode } = run('show', 'chatgpt');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('chatgpt');
      expect(stdout).toContain('Schema:');
      expect(stdout).toContain('v2');
      expect(stdout).toContain('https://chatgpt.com');
      expect(stdout).toContain('message_item');
      expect(stdout).toContain('composer_textarea');
      expect(stdout).toContain('send_button');
      expect(stdout).toContain('conversation_link');
      expect(stdout).toContain('Analysis Hints');
    });

    it('displays baseline info for boss', () => {
      const { stdout, exitCode } = run('show', 'boss');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('boss');
      expect(stdout).toContain('message_input');
      expect(stdout).toContain('send_button');
      expect(stdout).toContain('chat_list_item');
    });

    it('shows selector status icons', () => {
      const { stdout } = run('show', 'doubao');
      // doubao has known broken selectors from live testing
      expect(stdout).toContain('ok');  // at least some status info
    });

    it('errors for unknown site', () => {
      const { stderr, exitCode } = run('show', 'nonexistent-site-xyz');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('No baseline found');
    });

    it('missing site argument errors', () => {
      const { stderr, exitCode } = run('show');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Usage');
    });
  });

  describe('audit', () => {
    it('produces a table with all sites', () => {
      const { stdout, exitCode } = run('audit');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('dom-heal audit');
      expect(stdout).toContain('doubao');
      expect(stdout).toContain('deepseek');
      expect(stdout).toContain('chatgpt');
      expect(stdout).toContain('claude');
      expect(stdout).toContain('xiaohongshu');
      expect(stdout).toContain('boss');
    });

    it('shows health status column', () => {
      const { stdout } = run('audit');
      expect(stdout).toContain('Health');
      // doubao has live status
      expect(stdout).toContain('DEGRADED');
    });

    it('shows issues section for broken/degraded', () => {
      const { stdout } = run('audit');
      expect(stdout).toContain('Issues');
      expect(stdout).toContain('doubao: DEGRADED');
    });

    it('shows selector and role counts', () => {
      const { stdout } = run('audit');
      expect(stdout).toContain('Roles');
      expect(stdout).toContain('Sels');
    });
  });

  describe('onboard', () => {
    it('rejects already-registered site', () => {
      const { stdout } = run('onboard', 'doubao');
      expect(stdout).toContain('already in registry');
    });

    it('errors for non-existent adapter', () => {
      const { stderr, exitCode } = run('onboard', 'nonexistent-adapter-xyz');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('No adapter found');
    });
  });

  describe('error handling', () => {
    it('exits 1 with no subcommand', () => {
      const { exitCode } = run('');
      expect(exitCode).toBe(1);
    });

    it('check requires site argument', () => {
      const { stderr, exitCode } = run('check');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Usage');
    });

    it('diagnose requires site argument', () => {
      const { stderr, exitCode } = run('diagnose');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Usage');
    });

    it('save requires site argument', () => {
      const { stderr, exitCode } = run('save');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Usage');
    });

    it('changes requires site argument', () => {
      const { stderr, exitCode } = run('changes');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Usage');
    });
  });

  describe('show across all sites', () => {
    const sites = ['doubao', 'deepseek', 'chatgpt', 'claude', 'xiaohongshu', 'boss'];

    for (const site of sites) {
      it(`show ${site} has roles and analysis hints`, () => {
        const { stdout, exitCode } = run('show', site);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('Roles');
        expect(stdout).toContain('Selectors');

        // Every v2 baseline should show hints (at least empty or active)
        expect(stdout).toContain('Analysis Hints');
      });
    }
  });
});

describe('cli.mjs integration with registry', () => {
  it('registry default_urls are valid for all sites', () => {
    const registry = JSON.parse(
      require('fs').readFileSync(resolve(__dirname, '..', 'baselines', 'registry.json'), 'utf-8')
    );

    for (const [site, entry] of Object.entries(registry.sites)) {
      // Skip test entries
      if (site.startsWith('test-')) continue;
      expect(entry.default_url).toBeDefined();
      expect(entry.default_url).toMatch(/^https?:\/\//);
    }
  });

  it('every registry site has a valid baseline file', () => {
    const fs = require('fs');
    const registry = JSON.parse(
      fs.readFileSync(resolve(__dirname, '..', 'baselines', 'registry.json'), 'utf-8')
    );

    for (const [site] of Object.entries(registry.sites)) {
      if (site.startsWith('test-')) continue;
      const baselinePath = resolve(__dirname, '..', 'baselines', site, 'selector-roles.json');
      expect(fs.existsSync(baselinePath)).toBe(true);

      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
      expect(baseline.schema_version).toBe(2);
      expect(baseline.roles).toBeDefined();
      expect(Object.keys(baseline.roles).length).toBeGreaterThan(0);
    }
  });

  it('all baselines pass v2 validation', () => {
    const { validateV2 } = require('../lib/migrate.mjs');
    const fs = require('fs');
    const registry = JSON.parse(
      fs.readFileSync(resolve(__dirname, '..', 'baselines', 'registry.json'), 'utf-8')
    );

    for (const [site] of Object.entries(registry.sites)) {
      if (site.startsWith('test-')) continue;
      const baselinePath = resolve(__dirname, '..', 'baselines', site, 'selector-roles.json');
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
      const errors = validateV2(baseline);
      if (errors.length > 0) {
        console.error(`${site} validation errors:`, errors);
      }
      expect(errors).toHaveLength(0);
    }
  });
});
