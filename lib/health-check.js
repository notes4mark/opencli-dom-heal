/**
 * Lightweight DOM health pulse script.
 * Injected into the browser page via page.evaluate().
 * Only counts querySelectorAll matches — no text extraction, no DOM traversal.
 * Designed to run in < 10ms for quick health checks.
 *
 * Usage:
 *   import { HEALTH_CHECK_SCRIPT } from './health-check.js';
 *   const health = await page.evaluate(HEALTH_CHECK_SCRIPT);
 */

/**
 * Build a health check script from a selector-roles baseline.
 * @param {object} baseline - The selector-roles.json content
 * @returns {string} JS to inject via page.evaluate()
 */
export function buildHealthCheckScript(baseline) {
  const checks = Object.entries(baseline.roles).map(([roleName, roleDef]) => {
    const selectors = roleDef.selectors.map(s => s.css);
    return `    "${roleName}": (() => {
      const sels = ${JSON.stringify(selectors)};
      const results = [];
      for (const sel of sels) {
        try {
          const count = document.querySelectorAll(sel).length;
          results.push({ css: sel, count });
        } catch (e) {
          results.push({ css: sel, count: 0, error: e.message });
        }
      }
      const working = results.filter(r => r.count > 0).length;
      return {
        working: working,
        broken: results.length - working,
        total: results.length,
        status: working > 0 ? (working === results.length ? 'ok' : 'degraded') : 'broken',
        details: results
      };
    })()`;
  }).join(',\n');

  return `() => {
  return {
    url: window.location.href,
    timestamp: new Date().toISOString(),
    roles: {
${checks}
    }
  };
}`;
}

/**
 * Pre-built health check script for doubao (uses priority-1 selectors only).
 */
export const DOUBAO_HEALTH_SCRIPT = `() => {
  const roles = {
    message_list_container: '[class*="message-list"]',
    message_item: '[class*="inner-item-"], [class*="top-item-"]',
    user_message: '[class*="bg-g-send-msg-bubble"]',
    assistant_message: '.flow-markdown-body, .md-box-root',
    message_text: '[data-testid="message_text_content"], .flow-markdown-body',
    composer_textarea: 'textarea[data-testid="chat_input_input"], textarea',
    send_button: 'button#flow-end-msg-send, button[type="submit"]',
    conversation_link: 'a[href*="/chat/"]',
    captcha_indicator: 'iframe[src*="captcha"], iframe[src*="verify"]',
    meeting_card: '[data-testid="meeting-minutes-card"]'
  };

  const result = { url: window.location.href, timestamp: new Date().toISOString(), roles: {} };

  for (const [name, selector] of Object.entries(roles)) {
    try {
      const count = document.querySelectorAll(selector).length;
      result.roles[name] = { count, status: count > 0 ? 'ok' : 'alert' };
    } catch (e) {
      result.roles[name] = { count: 0, status: 'error', error: e.message };
    }
  }

  return result;
}`;

/**
 * Pre-built health check script for deepseek.
 */
export const DEEPSEEK_HEALTH_SCRIPT = `() => {
  const roles = {
    message_item: '.ds-message',
    composer_textarea: 'textarea[placeholder*="DeepSeek"], textarea',
    send_button: 'div[role="button"]:not(.ds-toggle-button)',
    conversation_link: 'a[href*="/a/chat/s/"]',
    thinking_container: '.ds-markdown--think',
    model_radio: 'div[role="radio"]',
    sidebar_toggle: 'div[tabindex="0"][role="button"]',
    feature_toggle: '.ds-toggle-button',
    login_indicator: 'img[src*="user-avatar"]',
    markdown_content: '.ds-markdown'
  };

  const result = { url: window.location.href, timestamp: new Date().toISOString(), roles: {} };

  for (const [name, selector] of Object.entries(roles)) {
    try {
      const count = document.querySelectorAll(selector).length;
      result.roles[name] = { count, status: count > 0 ? 'ok' : 'alert' };
    } catch (e) {
      result.roles[name] = { count: 0, status: 'error', error: e.message };
    }
  }

  return result;
}`;
