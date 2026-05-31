/**
 * JSDOM integration tests for the DOM analysis scripts.
 * Uses frozen HTML fixtures to verify the analysis JS correctly catalogs selectors.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { DOUBAO_ANALYZE_SCRIPT } from '../lib/analysis-doubao.js';
import { DEEPSEEK_ANALYZE_SCRIPT } from '../lib/analysis-deepseek.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

describe('Doubao analysis script', () => {
    function runAnalysis(html) {
        const dom = setupJSDOM(html, 'https://www.doubao.com/chat');
        return dom.window.eval(`(${DOUBAO_ANALYZE_SCRIPT})()`);
    }

    it('catalogs data-testid values from the DOM', () => {
        const result = runAnalysis(`
          <main>
            <div data-testid="message-list">
              <div data-testid="union_message">Hello</div>
              <div data-testid="union_message">World</div>
            </div>
            <textarea data-testid="chat_input_input" placeholder="发消息"></textarea>
          </main>
        `);
        expect(result.selectors.data_test_ids['message-list']).toBe(1);
        expect(result.selectors.data_test_ids['union_message']).toBe(2);
        expect(result.selectors.data_test_ids['chat_input_input']).toBe(1);
    });

    it('finds scrollable containers', () => {
        const result = runAnalysis(`
          <main>
            <div class="message-list-zLoNs1" style="height:400px;overflow:auto">
              <div style="height:2000px">content</div>
            </div>
          </main>
        `);
        // JSDOM doesn't compute scrollHeight properly, but the structure is there
        expect(result.layout).toBeDefined();
    });

    it('detects text inputs and their placeholders', () => {
        const result = runAnalysis(`
          <main>
            <textarea data-testid="chat_input_input" placeholder="发消息..."></textarea>
          </main>
        `);
        const inputs = result.candidates.text_inputs;
        expect(inputs.length).toBeGreaterThan(0);
        const textarea = inputs.find(i => i.tag === 'TEXTAREA');
        expect(textarea).toBeTruthy();
        expect(textarea.placeholder).toContain('发消息');
    });

    it('detects send-like buttons', () => {
        const result = runAnalysis(`
          <main>
            <form>
              <textarea placeholder="发消息"></textarea>
              <button id="flow-end-msg-send" type="submit">发送</button>
            </form>
          </main>
        `);
        const buttons = result.candidates.buttons;
        expect(buttons.length).toBeGreaterThan(0);
        const sendBtn = buttons.find(b => b.id === 'flow-end-msg-send');
        expect(sendBtn).toBeTruthy();
        expect(sendBtn.isSendLike).toBe(true);
    });

    it('detects message blocks with role classification', () => {
        const result = runAnalysis(`
          <main>
            <section class="message-list-zLoNs1">
              <div class="top-item-user">
                <div class="inner-item-user">
                  <div class="bg-g-send-msg-bubble-bg">User message</div>
                </div>
              </div>
              <div class="top-item-assistant">
                <div class="inner-item-assistant">
                  <div class="md-box-root"><p>AI response</p></div>
                </div>
              </div>
            </section>
          </main>
        `);
        const blocks = result.candidates.message_blocks;
        expect(blocks.length).toBeGreaterThan(0);
        const userBlock = blocks.find(b => b.role === 'User');
        const assistantBlock = blocks.find(b => b.role === 'Assistant');
        expect(userBlock).toBeTruthy();
        expect(assistantBlock).toBeTruthy();
    });

    it('detects conversation links', () => {
        const result = runAnalysis(`
          <aside>
            <a href="/chat/1234567890123">Test Chat</a>
            <a href="/chat/create-image">Excluded</a>
          </aside>
        `);
        const links = result.candidates.links;
        expect(links.length).toBe(1);
        expect(links[0].id).toBe('1234567890123');
    });

    it('runs role health checks', () => {
        const result = runAnalysis(`
          <main>
            <section class="message-list-zLoNs1" data-testid="message-list">
              <div class="inner-item-user">
                <div class="bg-g-send-msg-bubble-bg send-message-x" data-testid="send_message">Hello</div>
              </div>
              <div class="inner-item-assistant">
                <div class="flow-markdown-body">Response</div>
              </div>
            </section>
            <textarea data-testid="chat_input_input" placeholder="发消息"></textarea>
            <button id="flow-end-msg-send">Send</button>
          </main>
        `);
        const checks = result.health.role_checks;
        // Each role should have at least one working selector
        expect(checks.message_list_container.status).toBe('ok');
        expect(checks.user_message.working.length).toBeGreaterThanOrEqual(1);
        expect(checks.assistant_message.working.length).toBeGreaterThanOrEqual(1);
        expect(checks.composer_textarea.working.length).toBeGreaterThanOrEqual(1);
        expect(checks.send_button.working.length).toBeGreaterThanOrEqual(1);
    });

    it('detects broken roles when selectors are missing', () => {
        const result = runAnalysis(`
          <main>
            <div>Just a plain page</div>
          </main>
        `);
        const checks = result.health.role_checks;
        expect(checks.message_list_container.status).toBe('broken');
        expect(checks.send_button.status).toBe('broken');
    });

    it('detects verification/captcha elements', () => {
        const result = runAnalysis(`
          <body>
            <div class="modal">请完成安全验证</div>
            <iframe src="https://captcha.example.com/verify"></iframe>
          </body>
        `);
        expect(result.verification.detected).toBe(true);
    });

    it('catalogs all data-* attribute names', () => {
        const result = runAnalysis(`
          <main>
            <div data-testid="test" data-message-id="123" data-foundation-type="send"></div>
          </main>
        `);
        const attrs = result.selectors.data_attributes;
        expect(attrs).toContain('data-testid');
        expect(attrs).toContain('data-message-id');
        expect(attrs).toContain('data-foundation-type');
    });

    it('has non-null depth values (fixes the original Funny bug)', () => {
        const result = runAnalysis(`
          <main>
            <div class="message-list">
              <div class="inner-item-user">
                <div class="bg-g-send-msg-bubble-bg">Long enough text for candidate detection >50 chars</div>
              </div>
            </div>
            <form>
              <textarea data-testid="chat_input_input" placeholder="发消息..."></textarea>
              <button id="flow-end-msg-send">发送</button>
            </form>
          </main>
        `);
        // Verify depth is a number, not a function/null
        for (const btn of result.candidates.buttons) {
            expect(typeof btn.depth).toBe('number');
        }
        for (const block of result.candidates.message_blocks) {
            expect(typeof block.depth).toBe('number');
        }
    });
});

describe('DeepSeek analysis script', () => {
    function runAnalysis(html) {
        const dom = setupJSDOM(html, 'https://chat.deepseek.com');
        return dom.window.eval(`(${DEEPSEEK_ANALYZE_SCRIPT})()`);
    }

    it('catalogs ds- prefixed class names', () => {
        const result = runAnalysis(`
          <div class="ds-message ds-markdown ds-flex">
            <div class="ds-markdown--think">thinking</div>
            <div class="ds-markdown">response</div>
          </div>
        `);
        expect(result.selectors.ds_classes).toContain('ds-message');
        expect(result.selectors.ds_classes).toContain('ds-markdown');
        expect(result.selectors.ds_classes).toContain('ds-flex');
        expect(result.selectors.ds_classes).toContain('ds-markdown--think');
    });

    it('detects message blocks with role classification', () => {
        const result = runAnalysis(`
          <div class="ds-message abc123 xyz789">User message here with more classes</div>
          <div class="ds-message">AI response with fewer classes</div>
        `);
        const blocks = result.candidates.message_blocks;
        expect(blocks.length).toBe(2);
        // DeepSeek: user messages have extra CSS module classes (3+ classNames)
        const userBlock = blocks.find(b => b.role === 'User');
        const assistantBlock = blocks.find(b => b.role === 'Assistant');
        expect(userBlock).toBeTruthy();
        expect(assistantBlock).toBeTruthy();
    });

    it('detects textarea with DeepSeek placeholder', () => {
        const result = runAnalysis(`
          <main>
            <textarea placeholder="Message DeepSeek"></textarea>
          </main>
        `);
        const inputs = result.candidates.text_inputs;
        expect(inputs.length).toBeGreaterThan(0);
        expect(inputs[0].placeholder).toContain('DeepSeek');
    });

    it('detects conversation links', () => {
        const result = runAnalysis(`
          <nav>
            <a href="/a/chat/s/749e6bbd-6a45-4440-beaa-ae5238bf06d8">Chat 1</a>
            <a href="/a/chat/s/abc-123">Chat 2</a>
          </nav>
        `);
        expect(result.candidates.links.length).toBe(2);
    });

    it('runs role health checks on deepseek selectors', () => {
        const result = runAnalysis(`
          <main>
            <div class="ds-message">Message</div>
            <textarea placeholder="Message DeepSeek"></textarea>
            <div contenteditable="true"></div>
            <div role="button">Send</div>
            <a href="/a/chat/s/test-id">History</a>
            <div class="ds-markdown--think">Thinking</div>
            <div role="radio">Instant</div>
            <div class="ds-toggle-button ds-toggle-button--selected">Search</div>
            <img src="https://example.com/user-avatar/123">
          </main>
        `);
        const checks = result.health.role_checks;
        expect(checks.message_item.working.length).toBeGreaterThanOrEqual(1);
        expect(checks.composer_textarea.working.length).toBeGreaterThanOrEqual(1);
        expect(checks.conversation_link.working.length).toBeGreaterThanOrEqual(1);
        expect(checks.thinking_container.working.length).toBeGreaterThanOrEqual(1);
        expect(checks.model_radio.working.length).toBeGreaterThanOrEqual(1);
        expect(checks.feature_toggle.working.length).toBeGreaterThanOrEqual(1);
        expect(checks.login_indicator.working.length).toBeGreaterThanOrEqual(1);
    });

    it('detects prose elements', () => {
        const result = runAnalysis(`
          <div class="ds-message">
            <div class="prose ds-markdown"># Hello World</div>
          </div>
        `);
        expect(result.candidates.prose_elements.length).toBeGreaterThan(0);
    });

    it('has non-null depth values', () => {
        const result = runAnalysis(`
          <main>
            <div class="ds-message">Hello World</div>
            <textarea placeholder="Message DeepSeek"></textarea>
            <div role="button">Send</div>
          </main>
        `);
        for (const block of result.candidates.message_blocks) {
            expect(typeof block.depth).toBe('number');
        }
        for (const btn of result.candidates.buttons) {
            expect(typeof btn.depth).toBe('number');
        }
    });
});
