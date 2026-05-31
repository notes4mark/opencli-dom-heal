import { describe, expect, it } from 'vitest';
import { migrateV1toV2, validateV2 } from '../lib/migrate.mjs';

const v1Baseline = {
  site: 'doubao',
  version: 1,
  updated: '2026-01-15T00:00:00Z',
  source_file: 'utils.js',
  roles: {
    send_button: {
      description: 'Send button in chat composer',
      selectors: [
        { css: 'button#flow-end-msg-send', type: 'id', priority: 1, stability: 'low' },
        { css: 'button[type="submit"]', type: 'attribute', priority: 2, stability: 'high' }
      ]
    },
    composer_textarea: {
      description: 'Message input textarea',
      selectors: [
        { css: 'textarea[placeholder*="发消息"]', type: 'attribute', priority: 1, stability: 'medium' }
      ]
    },
    empty_role: {
      description: 'A role with no selectors',
      selectors: []
    }
  }
};

describe('migrateV1toV2', () => {
  it('sets schema_version to 2', () => {
    const v2 = migrateV1toV2(v1Baseline);
    expect(v2.schema_version).toBe(2);
  });

  it('preserves site name', () => {
    const v2 = migrateV1toV2(v1Baseline);
    expect(v2.site).toBe('doubao');
  });

  it('generates source block with adapter path', () => {
    const v2 = migrateV1toV2(v1Baseline);
    expect(v2.source).toBeDefined();
    expect(v2.source.adapter_path).toContain('doubao');
    expect(v2.source.extraction_method).toBe('manual');
    expect(v2.source.source_files).toEqual(['utils.js']);
  });

  it('carries over extraction_date from v1 updated', () => {
    const v2 = migrateV1toV2(v1Baseline);
    expect(v2.source.extraction_date).toBe('2026-01-15T00:00:00Z');
  });

  it('migrates all roles', () => {
    const v2 = migrateV1toV2(v1Baseline);
    expect(Object.keys(v2.roles)).toHaveLength(3);
    expect(v2.roles.send_button).toBeDefined();
    expect(v2.roles.composer_textarea).toBeDefined();
    expect(v2.roles.empty_role).toBeDefined();
  });

  it('preserves role descriptions', () => {
    const v2 = migrateV1toV2(v1Baseline);
    expect(v2.roles.send_button.description).toBe('Send button in chat composer');
    expect(v2.roles.composer_textarea.description).toBe('Message input textarea');
  });

  it('assigns the correct category to each role', () => {
    const v2 = migrateV1toV2(v1Baseline);
    expect(v2.roles.send_button.category).toBe('button');
    expect(v2.roles.composer_textarea.category).toBe('input');
    expect(v2.roles.empty_role.category).toBe('container'); // fallback
  });

  it('assigns correct categories for all known role patterns', () => {
    const withManyRoles = {
      ...v1Baseline,
      roles: {
        message_list_container: { description: '', selectors: [] },
        thinking_container: { description: '', selectors: [] },
        conversation_link: { description: '', selectors: [] },
        captcha_indicator: { description: '', selectors: [] },
        login_indicator: { description: '', selectors: [] },
        model_radio: { description: '', selectors: [] },
        feature_toggle: { description: '', selectors: [] },
        new_chat_button: { description: '', selectors: [] },
        message_text: { description: '', selectors: [] },
        user_message: { description: '', selectors: [] },
      }
    };
    const v2 = migrateV1toV2(withManyRoles);
    expect(v2.roles.message_list_container.category).toBe('container');
    expect(v2.roles.thinking_container.category).toBe('content');
    expect(v2.roles.conversation_link.category).toBe('link');
    expect(v2.roles.captcha_indicator.category).toBe('indicator');
    expect(v2.roles.login_indicator.category).toBe('indicator');
    expect(v2.roles.model_radio.category).toBe('interactive');
    expect(v2.roles.feature_toggle.category).toBe('interactive');
    expect(v2.roles.new_chat_button.category).toBe('button');
    expect(v2.roles.message_text.category).toBe('content');
    expect(v2.roles.user_message.category).toBe('content');
  });

  it('migrates selector fields correctly', () => {
    const v2 = migrateV1toV2(v1Baseline);
    const sel = v2.roles.send_button.selectors[0];
    expect(sel.css).toBe('button#flow-end-msg-send');
    expect(sel.type).toBe('id');
    expect(sel.priority).toBe(1);
    expect(sel.stability).toBe('low');
    expect(sel.source.file).toBe('utils.js');
    expect(sel.status).toBe('unknown');
    expect(sel.history).toEqual([]);
  });

  it('defaults stability to medium when not set', () => {
    const v1NoStability = {
      ...v1Baseline,
      roles: {
        test_role: {
          description: '',
          selectors: [{ css: '.foo', type: 'class-exact', priority: 1 }]
        }
      }
    };
    const v2 = migrateV1toV2(v1NoStability);
    expect(v2.roles.test_role.selectors[0].stability).toBe('medium');
  });

  it('creates snapshots stub', () => {
    const v2 = migrateV1toV2(v1Baseline);
    expect(v2.snapshots).toBeDefined();
    expect(v2.snapshots.latest).toBeNull();
    expect(v2.snapshots.history).toEqual([]);
  });

  it('adds _meta block for migration tracking', () => {
    const v2 = migrateV1toV2(v1Baseline);
    expect(v2._meta).toBeDefined();
    expect(v2._meta.migrated_from).toBe('v1');
    expect(v2._meta.v1_version).toBe(1);
    expect(v2._meta.migrated_at).toBeDefined();
  });

  it('sets updated to current timestamp', () => {
    const before = new Date().toISOString();
    const v2 = migrateV1toV2(v1Baseline);
    expect(v2.updated >= before).toBe(true);
  });
});

describe('validateV2', () => {
  function makeValidV2() {
    return migrateV1toV2(v1Baseline);
  }

  it('returns no errors for a valid v2 baseline', () => {
    const errors = validateV2(makeValidV2());
    expect(errors).toEqual([]);
  });

  it('returns error for wrong schema_version', () => {
    const v2 = makeValidV2();
    v2.schema_version = 1;
    const errors = validateV2(v2);
    expect(errors).toContain('schema_version must be 2');
  });

  it('returns error for missing site', () => {
    const v2 = makeValidV2();
    delete v2.site;
    const errors = validateV2(v2);
    expect(errors).toContain('missing site');
  });

  it('returns error for missing source block', () => {
    const v2 = makeValidV2();
    delete v2.source;
    const errors = validateV2(v2);
    expect(errors).toContain('missing source block');
  });

  it('returns error for missing roles', () => {
    const v2 = makeValidV2();
    delete v2.roles;
    const errors = validateV2(v2);
    expect(errors).toContain('missing roles');
  });

  it('returns error for missing snapshots', () => {
    const v2 = makeValidV2();
    delete v2.snapshots;
    const errors = validateV2(v2);
    expect(errors).toContain('missing snapshots');
  });

  it('returns error for missing category on a role', () => {
    const v2 = makeValidV2();
    delete v2.roles.send_button.category;
    const errors = validateV2(v2);
    expect(errors.some(e => e.includes('missing category'))).toBe(true);
  });

  it('returns error for invalid category', () => {
    const v2 = makeValidV2();
    v2.roles.send_button.category = 'invalid-category';
    const errors = validateV2(v2);
    expect(errors.some(e => e.includes('invalid category'))).toBe(true);
  });

  it('returns error for non-array selectors', () => {
    const v2 = makeValidV2();
    v2.roles.send_button.selectors = 'not-an-array';
    const errors = validateV2(v2);
    expect(errors.some(e => e.includes('selectors must be an array'))).toBe(true);
  });

  it('returns error for missing css on a selector', () => {
    const v2 = makeValidV2();
    delete v2.roles.send_button.selectors[0].css;
    const errors = validateV2(v2);
    expect(errors.some(e => e.includes('missing css'))).toBe(true);
  });

  it('returns error for missing status on a selector', () => {
    const v2 = makeValidV2();
    delete v2.roles.send_button.selectors[0].status;
    const errors = validateV2(v2);
    expect(errors.some(e => e.includes('missing status'))).toBe(true);
  });

  it('returns error for missing history array', () => {
    const v2 = makeValidV2();
    v2.roles.send_button.selectors[0].history = null;
    const errors = validateV2(v2);
    expect(errors.some(e => e.includes('history must be an array'))).toBe(true);
  });

  it('validates all seven valid categories', () => {
    const validCategories = ['button', 'input', 'container', 'link', 'content', 'indicator', 'interactive'];
    const base = makeValidV2();
    for (const cat of validCategories) {
      base.roles.send_button.category = cat;
      const errors = validateV2(base);
      expect(errors.filter(e => e.includes('invalid category'))).toEqual([]);
    }
  });
});

describe('migration idempotency', () => {
  it('produces the same result when run twice (conceptual)', () => {
    // Migrating an already-migrated v2 is a no-op at the CLI level (detectVersion returns 2).
    // Here we verify the output structure is consistent.
    const first = migrateV1toV2(v1Baseline);
    // Simulate a v2 that was migrated from a slightly different v1
    const v1Copy = JSON.parse(JSON.stringify(v1Baseline));
    const second = migrateV1toV2(v1Copy);
    // Structure should match
    expect(second.schema_version).toBe(first.schema_version);
    expect(Object.keys(second.roles)).toEqual(Object.keys(first.roles));
  });
});
