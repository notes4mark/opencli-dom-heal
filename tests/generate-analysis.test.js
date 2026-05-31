/**
 * Tests for the generic DOM analysis script generator.
 * Verifies that generated scripts run correctly in JSDOM and produce
 * health checks, candidates, and selector catalogs comparable to
 * the hand-tuned scripts.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

import { generateAnalysisScript } from '../lib/generate-analysis.mjs';
import { compareAnalysis } from '../lib/compare.mjs';

function setupJSDOM(html, url) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return this.textContent || ''; }
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 100, height: 24, top: 0, left: 0, right: 100, bottom: 24, x: 0, y: 0, toJSON: () => ({})
  });
  return dom;
}

function runGenerated(baseline, html, url) {
  const dom = setupJSDOM(html, url || 'https://example.com');
  const script = generateAnalysisScript(baseline);
  return dom.window.eval(`(${script})()`);
}

// Minimal v2 baseline with a few roles
const minimalV2Baseline = {
  schema_version: 2,
  site: 'testsite',
  updated: new Date().toISOString(),
  source: {
    adapter_path: '/tmp/test/',
    source_files: ['utils.js'],
    extraction_method: 'manual',
    extraction_date: '2026-01-01T00:00:00Z'
  },
  roles: {
    composer_textarea: {
      description: 'Message input',
      category: 'input',
      selectors: [
        { css: 'textarea[placeholder*="Message"]', type: 'attribute', priority: 1, stability: 'medium', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] },
        { css: 'textarea', type: 'tag', priority: 2, stability: 'high', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] }
      ]
    },
    send_button: {
      description: 'Send button',
      category: 'button',
      selectors: [
        { css: 'button[type="submit"]', type: 'attribute', priority: 1, stability: 'high', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] }
      ]
    },
    conversation_link: {
      description: 'Chat links',
      category: 'link',
      selectors: [
        { css: 'a[href*="/chat/"]', type: 'attribute', priority: 1, stability: 'high', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] }
      ]
    },
    message_list_container: {
      description: 'Message list',
      category: 'container',
      selectors: [
        { css: '[class*="message-list"]', type: 'class-substring', priority: 1, stability: 'medium', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] }
      ]
    }
  },
  snapshots: { latest: null, history: [] }
};

describe('generateAnalysisScript', () => {
  it('returns a string', () => {
    const script = generateAnalysisScript(minimalV2Baseline);
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(1000);
  });

  it('produces an IIFE that returns without throwing', () => {
    const html = '<main><textarea placeholder="Message"></textarea><button type="submit">Send</button></main>';
    const result = runGenerated(minimalV2Baseline, html);
    expect(result).toBeDefined();
    expect(result.url).toContain('example.com');
    expect(result.timestamp).toBeDefined();
  });

  it('produces valid JSON-serializable output', () => {
    const html = '<main><textarea></textarea></main>';
    const result = runGenerated(minimalV2Baseline, html);
    const json = JSON.stringify(result);
    expect(json).toBeDefined();
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe('generated health checks', () => {
  it('reports healthy roles when selectors match', () => {
    const html = `
      <main>
        <section class="message-list-wrapper">
          <textarea placeholder="Message someone..."></textarea>
          <button type="submit">Send</button>
          <a href="/chat/123">Chat 123</a>
        </section>
      </main>`;
    const result = runGenerated(minimalV2Baseline, html);
    const checks = result.health.role_checks;

    expect(checks.composer_textarea.status).toBe('ok');
    expect(checks.send_button.status).toBe('ok');
    expect(checks.conversation_link.status).toBe('ok');
    expect(checks.message_list_container.status).toBe('ok');
  });

  it('reports broken roles when selectors are missing', () => {
    const html = '<main><div>Empty page</div></main>';
    const result = runGenerated(minimalV2Baseline, html);
    const checks = result.health.role_checks;

    expect(checks.composer_textarea.status).toBe('broken');
    expect(checks.send_button.status).toBe('broken');
  });

  it('reports degraded when some selectors work and others fail', () => {
    const html = '<main><textarea>bare textarea, no placeholder</textarea></main>';
    const result = runGenerated(minimalV2Baseline, html);
    const checks = result.health.role_checks;

    expect(checks.composer_textarea.status).toBe('degraded');
    // The bare 'textarea' selector works but 'textarea[placeholder*="Message"]' doesn't
    expect(checks.composer_textarea.working.length).toBeGreaterThan(0);
    expect(checks.composer_textarea.broken.length).toBeGreaterThan(0);
  });

  it('tracks count for each working selector', () => {
    const html = `
      <main>
        <textarea placeholder="Message someone..."></textarea>
        <textarea placeholder="Other input"></textarea>
      </main>`;
    const result = runGenerated(minimalV2Baseline, html);
    const checks = result.health.role_checks;

    const working = checks.composer_textarea.working;
    const placeholderCheck = working.find(w => w.css === 'textarea[placeholder*="Message"]');
    expect(placeholderCheck).toBeDefined();
    expect(placeholderCheck.count).toBe(1);
  });

  it('handles roles with no selectors gracefully', () => {
    const baseline = {
      ...minimalV2Baseline,
      roles: {
        empty_role: {
          description: 'A role with no selectors',
          category: 'container',
          selectors: []
        }
      }
    };
    const html = '<main><div>content</div></main>';
    const result = runGenerated(baseline, html);
    expect(result.health.role_checks.empty_role).toBeDefined();
    expect(result.health.role_checks.empty_role.status).toBe('broken');
  });
});

describe('generated candidate scanning', () => {
  it('collects text inputs with placeholder and id', () => {
    const html = '<main><textarea id="chat-input" placeholder="Type here..."></textarea></main>';
    const result = runGenerated(minimalV2Baseline, html);
    const inputs = result.candidates.text_inputs;

    expect(inputs.length).toBeGreaterThan(0);
    const ta = inputs.find(i => i.id === 'chat-input');
    expect(ta).toBeDefined();
    expect(ta.placeholder).toBe('Type here...');
    expect(typeof ta.visible).toBe('boolean');
    expect(typeof ta.depth).toBe('number');
  });

  it('collects buttons with attributes', () => {
    const html = `
      <main>
        <button id="send-btn" type="submit">Send</button>
        <div role="button" aria-label="Search">🔍</div>
      </main>`;
    const result = runGenerated(minimalV2Baseline, html);
    const buttons = result.candidates.buttons;

    expect(buttons.length).toBe(2);
    const sendBtn = buttons.find(b => b.id === 'send-btn');
    expect(sendBtn).toBeDefined();
    expect(sendBtn.type).toBe('submit');
    expect(sendBtn.text).toBe('Send');
  });

  it('collects links when link category exists', () => {
    const html = `
      <nav>
        <a href="/chat/abc123">Chat 1</a>
        <a href="#section">Internal</a>
      </nav>`;
    const result = runGenerated(minimalV2Baseline, html);
    const links = result.candidates.links;

    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links.some(l => l.href === '/chat/abc123')).toBe(true);
  });

  it('skips link scanning when no link category in baseline', () => {
    const noLinkBaseline = {
      ...minimalV2Baseline,
      roles: {
        composer_textarea: minimalV2Baseline.roles.composer_textarea
      }
    };
    const html = '<main><a href="/chat/123">Chat</a></main>';
    const result = runGenerated(noLinkBaseline, html);
    expect(result.candidates.links).toEqual([]);
  });

  it('collects message blocks when content/container categories exist', () => {
    const html = `
      <main>
        <div class="message-list">
          <div data-message-id="1">Hello world this is a message with enough text</div>
          <div data-message-id="2">Second message here</div>
        </div>
      </main>`;
    const result = runGenerated(minimalV2Baseline, html);
    const blocks = result.candidates.message_blocks;

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every(b => typeof b.depth === 'number')).toBe(true);
  });

  it('collects scroll containers when container category exists', () => {
    const html = `
      <main>
        <div class="message-list-zLoNs1" style="height:400px;overflow:auto">
          <div style="height:2000px">scrolling content here</div>
        </div>
      </main>`;
    const result = runGenerated(minimalV2Baseline, html);
    expect(result.candidates.scroll_containers).toBeDefined();
  });
});

describe('analysis hints', () => {
  it('uses custom link_pattern from hints', () => {
    const hintedBaseline = {
      ...minimalV2Baseline,
      source: {
        ...minimalV2Baseline.source,
        analysis_hints: {
          link_pattern: 'a[href*="/custom/chat/"]'
        }
      }
    };
    const html = `
      <nav>
        <a href="/custom/chat/abc">Target</a>
        <a href="/other/page">Other</a>
      </nav>`;
    const result = runGenerated(hintedBaseline, html);
    const links = result.candidates.links;

    // Only the link matching the custom pattern should be collected
    expect(links.length).toBe(1);
    expect(links[0].href).toBe('/custom/chat/abc');
  });

  it('uses custom message_item_selectors from hints', () => {
    const hintedBaseline = {
      ...minimalV2Baseline,
      source: {
        ...minimalV2Baseline.source,
        analysis_hints: {
          message_item_selectors: ['.custom-msg']
        }
      }
    };
    const html = `
      <main>
        <div class="custom-msg">Target message with enough text to pass the minimum length check</div>
        <div class="other-msg">Other message with sufficient text content here too</div>
      </main>`;
    const result = runGenerated(hintedBaseline, html);
    const blocks = result.candidates.message_blocks;

    expect(blocks.length).toBe(1);
    expect(blocks[0].selector).toBe('.custom-msg');
  });

  it('runs verification detection when phrases are provided', () => {
    const hintedBaseline = {
      ...minimalV2Baseline,
      source: {
        ...minimalV2Baseline.source,
        analysis_hints: {
          verification_phrases: ['人机验证', 'captcha']
        }
      }
    };
    const html = `
      <body>
        <div>请完成人机验证</div>
      </body>`;
    const result = runGenerated(hintedBaseline, html);

    expect(result.verification).toBeDefined();
    expect(result.verification.detected).toBe(true);
    expect(result.verification.hasVerifyPhrase).toBe(true);
  });

  it('detects captcha iframes via verification section', () => {
    const hintedBaseline = {
      ...minimalV2Baseline,
      source: {
        ...minimalV2Baseline.source,
        analysis_hints: {
          verification_phrases: ['captcha']
        }
      }
    };
    const html = `
      <body>
        <iframe src="https://captcha.example.com/verify"></iframe>
      </body>`;
    const result = runGenerated(hintedBaseline, html);

    expect(result.verification).toBeDefined();
    expect(result.verification.hasVerifyFrame).toBe(true);
    expect(result.verification.detected).toBe(true);
  });

  it('skips verification section when no phrases provided', () => {
    const result = runGenerated(minimalV2Baseline, '<body>captcha</body>');
    expect(result.verification).toBeUndefined();
  });

  it('collects ds_classes when extra_selectors includes it', () => {
    const hintedBaseline = {
      ...minimalV2Baseline,
      source: {
        ...minimalV2Baseline.source,
        analysis_hints: {
          extra_selectors: ['ds_classes']
        }
      }
    };
    const html = `
      <main>
        <div class="ds-message ds-flex">
          <div class="ds-markdown">content</div>
        </div>
      </main>`;
    const result = runGenerated(hintedBaseline, html);

    expect(result.selectors.ds_classes).toBeDefined();
    expect(result.selectors.ds_classes).toContain('ds-message');
    expect(result.selectors.ds_classes).toContain('ds-flex');
    expect(result.selectors.ds_classes).toContain('ds-markdown');
  });
});

describe('interactive category scanning', () => {
  it('collects radio and switch elements when interactive category present', () => {
    const interactiveBaseline = {
      ...minimalV2Baseline,
      roles: {
        ...minimalV2Baseline.roles,
        model_radio: {
          description: 'Model selector',
          category: 'interactive',
          selectors: [
            { css: 'div[role="radio"]', type: 'role', priority: 1, stability: 'medium', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] }
          ]
        }
      }
    };
    const html = `
      <main>
        <div role="radio" aria-checked="true">Option A</div>
        <div role="switch" aria-checked="false">Toggle</div>
      </main>`;
    const result = runGenerated(interactiveBaseline, html);
    const buttons = result.candidates.buttons;

    // Should include radio and switch in buttons candidates
    const radio = buttons.find(b => b.role === 'radio');
    expect(radio).toBeDefined();
    expect(radio.checked).toBe('true');
  });
});

describe('generated script + compare engine integration', () => {
  it('works end-to-end with compareAnalysis', () => {
    const html = `
      <main>
        <section class="message-list-wrapper">
          <textarea placeholder="Message someone..."></textarea>
          <button type="submit">Send</button>
          <a href="/chat/456">Chat 456</a>
        </section>
      </main>`;
    const result = runGenerated(minimalV2Baseline, html);
    const report = compareAnalysis(result, minimalV2Baseline);

    expect(report.overallStatus).toBe('healthy');
    expect(report.summary.brokenRoles).toBe(0);
  });

  it('detects broken roles via compareAnalysis with generated script', () => {
    const html = '<main><div>Empty page, nothing matches</div></main>';
    const result = runGenerated(minimalV2Baseline, html);
    const report = compareAnalysis(result, minimalV2Baseline);

    expect(report.overallStatus).toBe('critical');
    expect(report.summary.brokenRoles).toBe(4);
  });
});

describe('real baseline verification', () => {
  // Load the actual doubao and deepseek v2 baselines and verify
  // the generator produces runnable scripts for both.

  function loadBaseline(site) {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const path = join(__dirname, '..', 'baselines', site, 'selector-roles.json');
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  it('generates a runnable script from the doubao v2 baseline', () => {
    const doubaoBaseline = loadBaseline('doubao');
    const script = generateAnalysisScript(doubaoBaseline);
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(5000);

    // Run against a minimal DOM
    const html = `
      <main>
        <div class="message-list-wrapper">
          <div class="inner-item-user">
            <div class="bg-g-send-msg-bubble-bg">User msg</div>
          </div>
          <div class="inner-item-assistant">
            <div class="flow-markdown-body">AI response</div>
          </div>
        </div>
        <textarea placeholder="发消息..."></textarea>
        <button id="flow-end-msg-send">Send</button>
        <a href="/chat/1234567890123">Chat history</a>
        <iframe src="https://captcha.example.com/verify"></iframe>
      </main>`;
    const result = runGenerated(doubaoBaseline, html, 'https://www.doubao.com/chat');

    expect(result.url).toBeDefined();
    expect(result.health.role_checks).toBeDefined();

    // The generated script's health checks should detect the elements
    const checks = result.health.role_checks;
    expect(checks.send_button).toBeDefined();
    expect(checks.composer_textarea).toBeDefined();
    expect(checks.conversation_link).toBeDefined();
    expect(checks.message_list_container).toBeDefined();
    expect(checks.message_item).toBeDefined();
    expect(checks.user_message).toBeDefined();
    expect(checks.assistant_message).toBeDefined();
    expect(checks.captcha_indicator).toBeDefined();

    // With all selectors present, these roles should be at least degraded
    expect(['ok', 'degraded']).toContain(checks.composer_textarea.status);
    expect(['ok', 'degraded']).toContain(checks.conversation_link.status);
  });

  it('generates a runnable script from the deepseek v2 baseline', () => {
    const deepseekBaseline = loadBaseline('deepseek');
    const script = generateAnalysisScript(deepseekBaseline);
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(5000);

    // Run against a minimal DeepSeek-style DOM
    const html = `
      <main>
        <div class="ds-message">Message content here</div>
        <textarea placeholder="Message DeepSeek"></textarea>
        <div contenteditable="true"></div>
        <div role="button">Send</div>
        <a href="/a/chat/s/abc-123">Chat history</a>
        <div class="ds-markdown--think">Thinking process</div>
        <div role="radio">Model selector</div>
        <div class="ds-toggle-button ds-toggle-button--selected">Feature</div>
        <img src="https://example.com/user-avatar/123">
      </main>`;
    const result = runGenerated(deepseekBaseline, html, 'https://chat.deepseek.com');

    expect(result.url).toBeDefined();
    expect(result.health.role_checks).toBeDefined();

    // Should have ds_classes from analysis_hints extra_selectors
    expect(result.selectors.ds_classes).toBeDefined();

    const checks = result.health.role_checks;
    expect(checks.message_item).toBeDefined();
    expect(checks.composer_textarea).toBeDefined();
    expect(checks.conversation_link).toBeDefined();
    expect(checks.thinking_container).toBeDefined();
    expect(checks.model_radio).toBeDefined();
    expect(checks.feature_toggle).toBeDefined();
    expect(checks.login_indicator).toBeDefined();
  });

  it('generated doubao script matches all 11 roles', () => {
    const doubaoBaseline = loadBaseline('doubao');
    const script = generateAnalysisScript(doubaoBaseline);
    const roleNames = Object.keys(doubaoBaseline.roles);

    // Verify each role name appears in the generated script
    for (const name of roleNames) {
      expect(script).toContain(name);
    }
  });

  it('generated deepseek script matches all 11 roles', () => {
    const deepseekBaseline = loadBaseline('deepseek');
    const script = generateAnalysisScript(deepseekBaseline);
    const roleNames = Object.keys(deepseekBaseline.roles);

    for (const name of roleNames) {
      expect(script).toContain(name);
    }
  });
});

describe('empty baseline handling', () => {
  it('handles baseline with no roles', () => {
    const emptyBaseline = {
      schema_version: 2,
      site: 'empty',
      updated: new Date().toISOString(),
      source: { adapter_path: '/tmp', source_files: [], extraction_method: 'manual', extraction_date: '' },
      roles: {},
      snapshots: { latest: null, history: [] }
    };
    const script = generateAnalysisScript(emptyBaseline);
    expect(typeof script).toBe('string');

    const result = runGenerated(emptyBaseline, '<main><div>test</div></main>');
    expect(result.health.role_checks).toEqual({});
    expect(result.layout).toBeDefined();
  });

  it('handles baseline without source block', () => {
    const noSourceBaseline = {
      schema_version: 2,
      site: 'nosource',
      roles: {
        test_role: {
          description: 'Test',
          category: 'container',
          selectors: [{ css: 'div', type: 'tag', priority: 1, stability: 'high', source: { file: '', extracted: '' }, status: 'unknown', history: [] }]
        }
      },
      snapshots: { latest: null, history: [] }
    };
    const script = generateAnalysisScript(noSourceBaseline);
    expect(typeof script).toBe('string');

    const result = runGenerated(noSourceBaseline, '<main><div>test</div></main>');
    expect(result.health.role_checks.test_role.status).toBe('ok');
  });
});

describe('generated script matches hand-tuned quality', () => {
  function loadBaseline(site) {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const path = join(__dirname, '..', 'baselines', site, 'selector-roles.json');
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  // Doubao-specific: button scoping, send/exclude patterns, bubble role detection, link ID extraction
  describe('doubao hints produce rich candidates', () => {
    const doubaoBaseline = loadBaseline('doubao');

    const html = `
      <main>
        <div class="message-list-wrapper">
          <div class="inner-item-user">
            <div class="bg-g-send-msg-bubble-bg">User message text here</div>
          </div>
          <div class="inner-item-assistant">
            <div class="flow-markdown-body">AI response here with enough text to pass</div>
          </div>
        </div>
        <form>
          <textarea placeholder="发消息..."></textarea>
          <button id="flow-end-msg-send" type="submit">发送</button>
          <button>新对话</button>
        </form>
        <a href="/chat/1234567890123">Chat History</a>
      </main>`;

    it('detects send-like vs excluded buttons', () => {
      const result = runGenerated(doubaoBaseline, html, 'https://www.doubao.com/chat');
      const buttons = result.candidates.buttons;

      expect(buttons.length).toBeGreaterThanOrEqual(2);
      const sendBtn = buttons.find(b => b.id === 'flow-end-msg-send');
      expect(sendBtn).toBeDefined();
      expect(sendBtn.isSendLike).toBe(true);

      const excludedBtn = buttons.find(b => b.text.includes('新对话'));
      expect(excludedBtn).toBeDefined();
      expect(excludedBtn.isExcluded).toBe(true);
    });

    it('detects message roles via bubble heuristic', () => {
      const result = runGenerated(doubaoBaseline, html, 'https://www.doubao.com/chat');
      const blocks = result.candidates.message_blocks;

      expect(blocks.length).toBeGreaterThanOrEqual(2);
      const userBlock = blocks.find(b => b.role === 'User');
      const asstBlock = blocks.find(b => b.role === 'Assistant');

      expect(userBlock).toBeDefined();
      expect(userBlock.hasUserBubble).toBe(true);
      expect(asstBlock).toBeDefined();
      expect(asstBlock.hasAssistantBubble).toBe(true);
    });

    it('extracts link IDs via regex hint', () => {
      const result = runGenerated(doubaoBaseline, html, 'https://www.doubao.com/chat');
      const links = result.candidates.links;

      expect(links.length).toBeGreaterThanOrEqual(1);
      const chatLink = links.find(l => l.id === '1234567890123');
      expect(chatLink).toBeDefined();
    });

    it('scopes buttons to composer area when available', () => {
      const htmlNoComposer = `
        <main>
          <button id="outside-btn">Click</button>
          <form>
            <button id="inside-btn" type="submit">Send</button>
          </form>
        </main>`;
      const result = runGenerated(doubaoBaseline, htmlNoComposer, 'https://www.doubao.com/chat');
      const buttons = result.candidates.buttons;

      // Both should be found (form is within body)
      expect(buttons.some(b => b.id === 'inside-btn')).toBe(true);
    });
  });

  // DeepSeek-specific: class-count role detection, ds_classes, prose elements, custom button selectors
  describe('deepseek hints produce rich candidates', () => {
    const deepseekBaseline = loadBaseline('deepseek');

    const html = `
      <main>
        <div class="ds-message abc def ghi">User message with many classes</div>
        <div class="ds-message">Assistant message</div>
        <div class="ds-message">
          <div class="prose ds-markdown"># Markdown content
            <pre><code>const x = 1;</code></pre>
          </div>
        </div>
        <textarea placeholder="Message DeepSeek"></textarea>
        <div role="button" aria-label="Send"></div>
        <div class="ds-icon-button">
          <svg></svg>
        </div>
        <a href="/a/chat/s/abc-123">Chat</a>
        <div class="ds-markdown--think">Thinking...</div>
      </main>`;

    it('detects ds_classes via extra_selectors hint', () => {
      const result = runGenerated(deepseekBaseline, html, 'https://chat.deepseek.com');
      expect(result.selectors.ds_classes).toBeDefined();
      expect(result.selectors.ds_classes).toContain('ds-message');
    });

    it('classifies messages by class-count heuristic', () => {
      const result = runGenerated(deepseekBaseline, html, 'https://chat.deepseek.com');
      const blocks = result.candidates.message_blocks;

      const userBlock = blocks.find(b => b.role === 'User');
      const asstBlock = blocks.find(b => b.role === 'Assistant');

      expect(userBlock).toBeDefined();
      expect(asstBlock).toBeDefined();
      expect(userBlock.classCount).toBeGreaterThan(2);
      expect(asstBlock.classCount).toBeLessThanOrEqual(2);
    });

    it('collects prose elements via content_selectors hint', () => {
      const result = runGenerated(deepseekBaseline, html, 'https://chat.deepseek.com');
      const prose = result.candidates.prose_elements;

      expect(prose).toBeDefined();
      expect(prose.length).toBeGreaterThanOrEqual(1);
      const codeProse = prose.find(p => p.hasCode);
      expect(codeProse).toBeDefined();
    });

    it('uses custom button selectors from hints', () => {
      const result = runGenerated(deepseekBaseline, html, 'https://chat.deepseek.com');
      const buttons = result.candidates.buttons;

      // Should find div[role="button"] and .ds-icon-button
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
  });

  // Verify generated and hand-tuned produce consistent health check results
  describe('health check parity with hand-tuned scripts', () => {
    it('generated doubao health checks match hand-tuned on same DOM', () => {
      const { DOUBAO_ANALYZE_SCRIPT } = require('../lib/analysis-doubao.js');
      const doubaoBaseline = loadBaseline('doubao');

      const html = `
        <main>
          <div class="message-list-wrapper">
            <div class="inner-item-user">
              <div class="bg-g-send-msg-bubble-bg">User msg</div>
            </div>
            <div class="inner-item-assistant">
              <div class="flow-markdown-body"><div class="md-box-root">AI</div></div>
            </div>
          </div>
          <textarea placeholder="发消息..."></textarea>
          <button id="flow-end-msg-send" type="submit">发送</button>
          <a href="/chat/1234567890123">Chat</a>
        </main>`;

      // Run both scripts
      const { JSDOM } = require('jsdom');
      function runScript(script, url) {
        const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
        Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
          configurable: true, get() { return this.textContent || ''; }
        });
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
          width: 100, height: 24, top: 0, left: 0, right: 100, bottom: 24, x: 0, y: 0, toJSON: () => ({})
        });
        return dom.window.eval(`(${script})()`);
      }

      const handTuned = runScript(DOUBAO_ANALYZE_SCRIPT, 'https://www.doubao.com/chat');
      const generated = runScript(generateAnalysisScript(doubaoBaseline), 'https://www.doubao.com/chat');

      // Compare role health check statuses
      const htChecks = handTuned.health.role_checks;
      const genChecks = generated.health.role_checks;

      for (const roleName of Object.keys(htChecks)) {
        expect(genChecks[roleName]).toBeDefined();
        expect(genChecks[roleName].status).toBe(htChecks[roleName].status);
      }
    });
  });

  // Phase 5: Verify generated scripts execute for all onboarded adapters
  describe('onboarded adapter baselines (Phase 5)', () => {
    const { JSDOM } = require('jsdom');

    function runGeneratedOnHtml(baseline, html, url) {
      const script = generateAnalysisScript(baseline);
      const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
      Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
        configurable: true, get() { return this.textContent || ''; }
      });
      dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
        width: 100, height: 24, top: 0, left: 0, right: 100, bottom: 24, x: 0, y: 0, toJSON: () => ({})
      });
      return dom.window.eval(`(${script})()`);
    }

    it('generates a runnable script from the chatgpt v2 baseline', () => {
      const chatgptBaseline = loadBaseline('chatgpt');
      const html = `
        <main>
          <article data-testid="conversation-turn-1">
            <div data-message-author-role="user">Hello</div>
          </article>
          <article data-testid="conversation-turn-2">
            <div data-message-author-role="assistant">
              <div class="markdown">Hi there!</div>
            </div>
          </article>
          <textarea id="prompt-textarea" data-testid="prompt-textarea" placeholder="Ask anything"></textarea>
          <button data-testid="send-button">Send</button>
          <a href="/c/abc-123-def">Chat history</a>
          <button data-testid="profile-button">Profile</button>
        </main>`;
      const result = runGeneratedOnHtml(chatgptBaseline, html, 'https://chatgpt.com');

      expect(result.url).toBeDefined();
      expect(result.health.role_checks.composer_textarea).toBeDefined();
      expect(result.health.role_checks.send_button).toBeDefined();
      expect(result.health.role_checks.conversation_link).toBeDefined();
      expect(result.health.role_checks.message_item).toBeDefined();
      expect(['ok', 'degraded']).toContain(result.health.role_checks.composer_textarea.status);
      expect(['ok', 'degraded']).toContain(result.health.role_checks.send_button.status);
    });

    it('generates a runnable script from the claude v2 baseline', () => {
      const claudeBaseline = loadBaseline('claude');
      const html = `
        <main>
          <div data-testid="user-message">User message</div>
          <div class="font-claude-response">Claude response</div>
          <div data-testid="chat-input" contenteditable="true"></div>
          <button aria-label="Send Message">Send</button>
          <a href="/chat/abc-123-def-456">Chat history</a>
          <button data-testid="user-menu-button">Menu</button>
          <button data-testid="model-selector-dropdown">Model</button>
          <input data-testid="file-upload" type="file" />
        </main>`;
      const result = runGeneratedOnHtml(claudeBaseline, html, 'https://claude.ai/new');

      expect(result.url).toBeDefined();
      expect(result.health.role_checks.composer_textarea).toBeDefined();
      expect(result.health.role_checks.send_button).toBeDefined();
      expect(result.health.role_checks.conversation_link).toBeDefined();
      expect(result.health.role_checks.user_message).toBeDefined();
      expect(result.health.role_checks.assistant_message).toBeDefined();
      expect(['ok', 'degraded']).toContain(result.health.role_checks.user_message.status);
    });

    it('generates a runnable script from the xiaohongshu v2 baseline', () => {
      const xhsBaseline = loadBaseline('xiaohongshu');
      const html = `
        <main>
          <section class="note-item">
            <a class="cover mask" href="/search_result/abc123def456789012345678">
              <span>Note title here</span>
            </a>
            <div class="footer"><div class="title"><span>My Note Title</span></div></div>
            <a class="author" href="/user/profile/author123"><span class="name">AuthorName</span></a>
            <span class="like-wrapper"><span class="count">1.2k</span></span>
          </section>
          <section class="note-item query-note-item">
            <a href="/explore/related123456789012345678">Related note</a>
          </section>
        </main>`;
      const result = runGeneratedOnHtml(xhsBaseline, html, 'https://www.xiaohongshu.com/search_result');

      expect(result.url).toBeDefined();
      expect(result.health.role_checks.search_result_item).toBeDefined();
      expect(result.health.role_checks.note_link).toBeDefined();
      expect(result.health.role_checks.note_title).toBeDefined();
      expect(result.health.role_checks.note_author).toBeDefined();
      expect(['ok', 'degraded']).toContain(result.health.role_checks.note_link.status);
    });

    it('generates a runnable script from the boss v2 baseline', () => {
      const bossBaseline = loadBaseline('boss');
      const html = `
        <main>
          <div class="chat-editor">
            <div contenteditable="true">Type here</div>
            <div class="conversation-editor">
              <button class="submit">Send</button>
            </div>
          </div>
          <div class="geek-item" id="_12345-0">Contact 1</div>
          <div class="geek-item" id="_67890-0">Contact 2</div>
        </main>`;
      const result = runGeneratedOnHtml(bossBaseline, html, 'https://www.zhipin.com/web/chat/index');

      expect(result.url).toBeDefined();
      expect(result.health.role_checks.message_input).toBeDefined();
      expect(result.health.role_checks.send_button).toBeDefined();
      expect(result.health.role_checks.chat_list_item).toBeDefined();
      expect(['ok', 'degraded']).toContain(result.health.role_checks.message_input.status);
    });
  });
});
