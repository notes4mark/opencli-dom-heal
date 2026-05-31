/**
 * DeepSeek DOM analysis script — injected into the browser page via page.evaluate().
 * Ported from Funny/analyze_dom.py DEEPSEEK_ANALYZE_JS with improvements:
 *   - depth is computed as a number (not a function) for JSON serialization
 *   - Role-aware selectors match .dom-baselines/deepseek/selector-roles.json
 *   - Output aligned with snapshot.json schema
 *
 * Usage:
 *   import { DEEPSEEK_ANALYZE_SCRIPT } from './analysis-deepseek.js';
 *   const result = await page.evaluate(DEEPSEEK_ANALYZE_SCRIPT);
 */
export const DEEPSEEK_ANALYZE_SCRIPT = `() => {
  const results = {
    url: window.location.href,
    timestamp: new Date().toISOString(),
    layout: {},
    selectors: {
      data_test_ids: {},
      data_attributes: {},
      id_selectors: {},
      class_prefixes: {},
      ds_classes: []
    },
    candidates: {
      text_inputs: [],
      buttons: [],
      scroll_containers: [],
      message_blocks: [],
      links: [],
      prose_elements: []
    },
    health: {
      role_checks: {}
    }
  };

  function computeDepth(el) {
    let d = 0;
    let p = el;
    while (p && p !== document.body) { d++; p = p.parentElement; }
    return d;
  }

  function isVisible(el) {
    if (!el || el.offsetParent === null) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function shortClass(el, maxLen) {
    return (el.className && typeof el.className === 'string')
      ? el.className.toString().substring(0, maxLen || 120) : '';
  }

  // ===== 1. Layout: main containers =====
  const mainContainers = document.querySelectorAll(
    'main, [role="main"], [class*="main"], [class*="chat-container"], [class*="conversation"]'
  );
  results.layout.mainContainers = Array.from(mainContainers).slice(0, 10).map(el => ({
    tag: el.tagName,
    id: el.id || null,
    class: shortClass(el, 200),
    childCount: el.children.length,
    visible: isVisible(el)
  }));

  // ===== 2. Layout: scrollable containers =====
  const scrollable = [];
  document.querySelectorAll('div').forEach(el => {
    if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) {
      scrollable.push({
        tag: el.tagName,
        class: shortClass(el, 150),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        childCount: el.children.length
      });
    }
  });
  results.layout.scrollableContainers = scrollable.slice(0, 10);

  // ===== 3. All data-testid values =====
  const testIdCounts = {};
  document.querySelectorAll('[data-testid]').forEach(el => {
    const val = el.getAttribute('data-testid');
    testIdCounts[val] = (testIdCounts[val] || 0) + 1;
  });
  results.selectors.data_test_ids = testIdCounts;

  // ===== 4. All data-* attribute names =====
  const dataAttrNames = new Set();
  document.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      if (attr.name.startsWith('data-')) dataAttrNames.add(attr.name);
    });
  });
  results.selectors.data_attributes = Array.from(dataAttrNames).sort();

  // ===== 5. DS-prefixed class names (DeepSeek-specific) =====
  const dsClasses = new Set();
  document.querySelectorAll('[class*="ds-"]').forEach(el => {
    if (typeof el.className !== 'string') return;
    el.className.split(/\\s+/).forEach(c => {
      if (c.startsWith('ds-')) dsClasses.add(c);
    });
  });
  results.selectors.ds_classes = Array.from(dsClasses).sort();

  // ===== 6. Class prefix analysis =====
  const classPrefixes = {};
  document.querySelectorAll('[class]').forEach(el => {
    if (typeof el.className !== 'string') return;
    el.className.split(/\\s+/).forEach(c => {
      if (!c) return;
      const prefix = c.substring(0, 8);
      classPrefixes[prefix] = (classPrefixes[prefix] || 0) + 1;
    });
  });
  results.selectors.class_prefixes = classPrefixes;

  // ===== 7. Candidates: text inputs =====
  document.querySelectorAll('textarea, [contenteditable="true"]').forEach(el => {
    results.candidates.text_inputs.push({
      tag: el.tagName,
      id: el.id || null,
      class: shortClass(el, 100),
      placeholder: el.placeholder || el.getAttribute('placeholder') || '',
      visible: isVisible(el),
      depth: computeDepth(el),
      textLength: (el.innerText || '').length
    });
  });

  // ===== 8. Candidates: buttons (send and action buttons) =====
  document.querySelectorAll('div[role="button"], button, [class*="ds-icon-button"]').forEach(el => {
    const text = (el.innerText || el.textContent || '').trim();
    const ariaLabel = el.getAttribute('aria-label') || '';
    const hasSvg = !!el.querySelector('svg');
    results.candidates.buttons.push({
      tag: el.tagName,
      id: el.id || null,
      class: shortClass(el, 100),
      text: text.substring(0, 50),
      ariaLabel: ariaLabel.substring(0, 50),
      disabled: el.getAttribute('aria-disabled') === 'true' || el.disabled === true,
      visible: isVisible(el),
      depth: computeDepth(el),
      hasSvg: hasSvg,
      isToggle: el.className && typeof el.className === 'string' && el.className.includes('ds-toggle-button')
    });
  });

  // ===== 9. Candidates: message blocks (.ds-message elements) =====
  document.querySelectorAll('.ds-message').forEach(el => {
    const text = (el.innerText || '').trim();
    const classCount = el.className && typeof el.className === 'string'
      ? el.className.split(/\\s+/).length : 0;
    const hasThink = !!el.querySelector('.ds-think-content, [class*="think"]');
    const hasMarkdown = !!el.querySelector('.ds-markdown, .ds-markdown-paragraph');
    const role = classCount > 2 ? 'User' : 'Assistant';

    results.candidates.message_blocks.push({
      role: role,
      class: shortClass(el, 150),
      classCount: classCount,
      textPreview: text.substring(0, 300),
      textLength: text.length,
      childCount: el.children.length,
      hasThink: hasThink,
      hasMarkdown: hasMarkdown,
      visible: isVisible(el),
      depth: computeDepth(el)
    });
  });

  // ===== 10. Candidates: markdown/prose elements =====
  document.querySelectorAll('.ds-markdown, .ds-markdown-paragraph, [class*="prose"]').forEach((el, i) => {
    results.candidates.prose_elements.push({
      index: i,
      class: shortClass(el, 150),
      textPreview: (el.innerText || '').substring(0, 300),
      textLength: (el.innerText || '').length,
      hasCode: !!el.querySelector('pre, code'),
      visible: isVisible(el),
      depth: computeDepth(el),
      parentClass: el.parentElement ? shortClass(el.parentElement, 100) : null
    });
  });

  // ===== 11. Candidates: conversation links (sidebar) =====
  document.querySelectorAll('a[href*="/a/chat/s/"]').forEach(a => {
    results.candidates.links.push({
      href: a.getAttribute('href') || '',
      text: (a.textContent || a.innerText || '').trim().substring(0, 200),
      visible: isVisible(a),
      depth: computeDepth(a)
    });
  });

  // ===== 12. Scroll containers as candidates =====
  scrollable.slice(0, 5).forEach(sc => {
    const match = sc.class.match(/[a-zA-Z0-9_-]+/);
    sc.selector = '[class*="' + (match ? match[0] : 'unknown') + '"]';
    results.candidates.scroll_containers.push(sc);
  });

  // ===== 13. Role health checks =====
  function checkRole(name, selectors) {
    const roleResults = { working: [], broken: [] };
    selectors.forEach(s => {
      try {
        const count = document.querySelectorAll(s).length;
        if (count > 0) roleResults.working.push({ css: s, count: count });
        else roleResults.broken.push({ css: s, count: 0 });
      } catch (e) {
        roleResults.broken.push({ css: s, count: 0, error: e.message });
      }
    });
    roleResults.status = roleResults.working.length > 0
      ? (roleResults.broken.length === 0 ? 'ok' : 'degraded')
      : 'broken';
    return roleResults;
  }

  results.health.role_checks = {
    message_item: checkRole('message_item', ['.ds-message']),
    composer_textarea: checkRole('composer_textarea', [
      'textarea[placeholder*="DeepSeek"]', 'textarea', '[contenteditable="true"]'
    ]),
    send_button: checkRole('send_button', [
      'div[role="button"]:not(.ds-toggle-button)'
    ]),
    conversation_link: checkRole('conversation_link', [
      'a[href*="/a/chat/s/"]'
    ]),
    thinking_container: checkRole('thinking_container', [
      '.ds-think-content', '[class*="think"]'
    ]),
    model_radio: checkRole('model_radio', ['div[role="radio"]']),
    sidebar_toggle: checkRole('sidebar_toggle', [
      'div[tabindex="0"][role="button"]'
    ]),
    feature_toggle: checkRole('feature_toggle', [
      '.ds-toggle-button', '.ds-toggle-button--selected'
    ]),
    login_indicator: checkRole('login_indicator', [
      'img[src*="user-avatar"]'
    ]),
    markdown_content: checkRole('markdown_content', [
      '.ds-markdown', '.ds-markdown-paragraph'
    ])
  };

  // ===== 14. Custom: thinking_header — text-based matching =====
  // .ds-thinking-header was removed. The thinking time header ("已思考（用时 X 秒）")
  // is now a hashed div sibling before .ds-think-content.
  (function() {
    const working = [], broken = [];
    const thinkPattern = /(已思考|Thought|Thinking|思考中)/i;

    // Method 1: Check for text matching the think header pattern in ds-message
    let foundHeader = false;
    document.querySelectorAll('.ds-message').forEach(el => {
      const text = (el.innerText || '').trim();
      if (thinkPattern.test(text)) {
        foundHeader = true;
      }
    });
    if (foundHeader) {
      working.push({ css: '.ds-message (text match for thinking header)', count: 1 });
    } else {
      broken.push({ css: '.ds-thinking-header', count: 0 });
    }

    // Method 2: Look for hashed div immediately before .ds-think-content
    let foundSibling = false;
    document.querySelectorAll('.ds-think-content').forEach(el => {
      const prev = el.previousElementSibling;
      if (prev && thinkPattern.test((prev.innerText || '').trim())) {
        foundSibling = true;
      }
    });
    if (foundSibling) {
      working.push({ css: '.ds-think-content (prev sibling header)', count: 1 });
    } else {
      broken.push({ css: "[class*='think'] ~ *", count: 0 });
    }

    results.health.role_checks.thinking_header = {
      working,
      broken,
      status: working.length > 0 ? (broken.length === 0 ? 'ok' : 'degraded') : 'broken'
    };
  })();

  return results;
}`;
