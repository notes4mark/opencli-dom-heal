/**
 * Doubao DOM analysis script — injected into the browser page via page.evaluate().
 * Ported from Funny/analyze_dom.py DOUBAO_ANALYZE_JS with improvements:
 *   - depth is computed as a number (not a function) for JSON serialization
 *   - Role-aware selectors match .dom-baselines/doubao/selector-roles.json
 *   - Output aligned with snapshot.json schema
 *
 * Usage:
 *   import { DOUBAO_ANALYZE_SCRIPT } from './analysis-doubao.js';
 *   const result = await page.evaluate(DOUBAO_ANALYZE_SCRIPT);
 */
export const DOUBAO_ANALYZE_SCRIPT = `() => {
  const results = {
    url: window.location.href,
    timestamp: new Date().toISOString(),
    layout: {},
    selectors: {
      data_test_ids: {},
      data_attributes: {},
      id_selectors: {},
      class_prefixes: {}
    },
    candidates: {
      text_inputs: [],
      buttons: [],
      scroll_containers: [],
      message_blocks: [],
      links: []
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
    'main, [role="main"], [class*="main"], [class*="container"], [class*="wrapper"], [class*="layout"]'
  );
  results.layout.mainContainers = Array.from(mainContainers).slice(0, 10).map(el => ({
    tag: el.tagName,
    id: el.id || null,
    class: shortClass(el, 200),
    role: el.getAttribute('role') || null,
    childCount: el.children.length,
    visible: isVisible(el)
  }));

  // ===== 2. Layout: scrollable containers (likely chat areas) =====
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

  // ===== 5. All element IDs =====
  const idMap = {};
  document.querySelectorAll('[id]').forEach(el => {
    idMap[el.id] = (idMap[el.id] || 0) + 1;
  });
  results.selectors.id_selectors = idMap;

  // ===== 6. Class prefix/substring analysis =====
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
  const inputSelectors = [
    'textarea', '[contenteditable="true"]', '[role="textbox"]', 'input[type="text"]'
  ];
  const seenInputs = new Set();
  inputSelectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      if (seenInputs.has(el)) return;
      seenInputs.add(el);
      const placeholder = el.placeholder || el.getAttribute('placeholder') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const css = (el.id ? '#' + el.id : el.tagName.toLowerCase()) +
        (placeholder ? '[placeholder*="' + placeholder.substring(0, 10) + '"]' : '');
      results.candidates.text_inputs.push({
        css: css,
        tag: el.tagName,
        id: el.id || null,
        class: shortClass(el, 100),
        placeholder: placeholder,
        ariaLabel: ariaLabel,
        visible: isVisible(el),
        depth: computeDepth(el),
        textLength: (el.innerText || '').length
      });
    });
  });

  // ===== 8. Candidates: buttons =====
  const sendPattern = /(send|发送|提交|发消息|Send|Submit)/i;
  const excludeBtnPattern = /(新对话|New Chat|快速|视频生成|深入研究|图像生成|帮我写作|音乐生成|更多|上传|upload|麦克风|microphone|模式|mode|工具|tools|设置|settings|云盘|history|历史)/i;
  const composerArea = document.querySelector('.chat-input, .chat-editor, [data-testid="chat_input"], form, [role="form"]');
  const btnScope = composerArea || document.body;

  btnScope.querySelectorAll('button, [role="button"]').forEach(el => {
    const text = (el.innerText || el.textContent || '').trim();
    const ariaLabel = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    const combined = (text + ' ' + ariaLabel + ' ' + title).toLowerCase();
    const isSendLike = sendPattern.test(combined);
    const isExcluded = excludeBtnPattern.test(combined);
    const visible = isVisible(el);

    results.candidates.buttons.push({
      tag: el.tagName,
      id: el.id || null,
      class: shortClass(el, 100),
      text: text.substring(0, 50),
      ariaLabel: ariaLabel.substring(0, 50),
      title: title.substring(0, 50),
      type: el.getAttribute('type') || null,
      disabled: el.disabled || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true',
      visible: visible,
      depth: computeDepth(el),
      isSendLike: isSendLike,
      isExcluded: isExcluded,
      css: (el.id ? '#' + el.id : el.tagName.toLowerCase()) +
        (el.getAttribute('type') ? '[type="' + el.getAttribute('type') + '"]' : '')
    });
  });

  // ===== 9. Candidates: message blocks =====
  const itemSelectors = [
    '[class*="inner-item-"]', '[class*="top-item-"]',
    '[data-message-id]', '[data-testid="union_message"]',
    '[data-testid="message-block-container"]',
    '[class*="item-kDun2N"]'
  ];
  itemSelectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      const text = (el.innerText || '').trim();
      if (text.length < 1) return;
      const hasUserBubble = !!el.querySelector('[class*="bg-g-send-msg-bubble"], [class*="send-message"]');
      const hasAssistantBubble = !!el.querySelector('.flow-markdown-body, .md-box-root, .container-h3Yzeb, [class*="receive-message"]');
      let role = 'unknown';
      if (hasUserBubble && !hasAssistantBubble) role = 'User';
      else if (hasAssistantBubble && !hasUserBubble) role = 'Assistant';
      else if (hasUserBubble) role = 'User';
      else if (hasAssistantBubble) role = 'Assistant';

      results.candidates.message_blocks.push({
        selector: sel,
        tag: el.tagName,
        class: shortClass(el, 150),
        role: role,
        textPreview: text.substring(0, 200),
        textLength: text.length,
        childCount: el.children.length,
        hasUserBubble: hasUserBubble,
        hasAssistantBubble: hasAssistantBubble,
        visible: isVisible(el),
        depth: computeDepth(el)
      });
    });
  });

  // ===== 10. Candidates: scroll containers =====
  scrollable.slice(0, 5).forEach(sc => {
    sc.selector = '[class*="' + (sc.class.match(/[a-zA-Z0-9_-]+/) || ['unknown'])[0] + '"]';
    results.candidates.scroll_containers.push(sc);
  });

  // ===== 11. Candidates: conversation links (sidebar) =====
  const excludePaths = ['/chat/create-image', '/chat/drive', '/chat/new-thread'];
  document.querySelectorAll('a[href*="/chat/"]').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (excludePaths.some(p => href.startsWith(p))) return;
    const match = href.match(/\\/chat\\/(\\d{10,})/);
    results.candidates.links.push({
      href: href,
      id: match ? match[1] : null,
      text: (a.textContent || a.innerText || '').trim().substring(0, 200),
      visible: isVisible(a),
      depth: computeDepth(a)
    });
  });

  // ===== 12. Role health checks =====
  // Pre-activate: type text to trigger conditional UI elements (send button)
  (function() {
    const textarea = document.querySelector('textarea[placeholder*="发消息"], textarea');
    if (textarea) {
      var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, 'test');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })();

  function checkRole(name, selectors) {
    const results = { working: [], broken: [] };
    selectors.forEach(s => {
      try {
        const count = document.querySelectorAll(s).length;
        if (count > 0) results.working.push({ css: s, count: count });
        else results.broken.push({ css: s, count: 0 });
      } catch (e) {
        results.broken.push({ css: s, count: 0, error: e.message });
      }
    });
    const status = results.working.length > 0
      ? (results.broken.length === 0 ? 'ok' : 'degraded')
      : 'broken';
    results.status = status;
    return results;
  }

  results.health.role_checks = {
    message_list_container: checkRole('message_list_container', [
      '[class*="message-list"]', '[data-testid="message-list"]'
    ]),
    message_item: checkRole('message_item', [
      '[class*="inner-item-"]', '[data-target-id="message-box-target-id"]',
      '[class*="top-item-"]', '[data-message-id]',
      '[class*="item-kDun2N"]', '[data-testid="union_message"]'
    ]),
    user_message: checkRole('user_message', [
      '[class*="bg-g-send-msg-bubble"]', '[data-testid="send_message"]',
      '[class*="send-message"]'
    ]),
    assistant_message: checkRole('assistant_message', [
      '.flow-markdown-body', '.md-box-root', '.container-h3Yzeb',
      '[data-testid="receive_message"]', '[class*="receive-message"]'
    ]),
    message_text: checkRole('message_text', [
      '[data-testid="message_text_content"]', '[data-testid="message_content"]',
      '.flow-markdown-body', '.md-box-root'
    ]),
    composer_textarea: checkRole('composer_textarea', [
      'textarea[data-testid="chat_input_input"]', 'textarea[placeholder*="发消息"]',
      '[contenteditable="true"]', 'textarea'
    ]),
    send_button: checkRole('send_button', [
      'button#flow-end-msg-send', 'button[class*="bg-dbx-text-highlight"]',
      'button[class*="bg-dbx-fill-highlight"]', 'button[type="submit"]'
    ]),
    conversation_link: checkRole('conversation_link', [
      'a[href*="/chat/"]'
    ]),
    captcha_indicator: checkRole('captcha_indicator', [
      'iframe[src*="captcha"]', 'iframe[src*="verify"]',
      'input[placeholder*="验证码"]'
    ]),
    meeting_card: checkRole('meeting_card', [
      '[data-testid="meeting-minutes-card"]'
    ])
  };

  // Custom: new_chat_button — requires text content matching, :has-text() is Playwright-only
  (function() {
    const working = [], broken = [];
    const chatPattern = /^(新对话|New Chat)$/i;

    // Method 1: sidebar cursor-pointer divs (the actual new-chat button is a div)
    const sidebar = document.querySelector('#flow_chat_sidebar');
    const cursorDivs = sidebar ? sidebar.querySelectorAll('div') : [];
    let foundCursor = false;
    cursorDivs.forEach(el => {
      const text = (el.innerText || '').trim();
      if (chatPattern.test(text) && isVisible(el)) {
        foundCursor = true;
      }
    });
    if (foundCursor) {
      working.push({ css: '#flow_chat_sidebar div.cursor-pointer:has(span)', count: 1 });
    } else {
      broken.push({ css: '#flow_chat_sidebar div.cursor-pointer:has(span)', count: 0 });
    }

    // Method 2: generic div with direct span child
    let foundGeneric = false;
    document.querySelectorAll('div:has(> span)').forEach(el => {
      const text = (el.innerText || '').trim();
      if (chatPattern.test(text) && isVisible(el)) {
        foundGeneric = true;
      }
    });
    if (foundGeneric) {
      working.push({ css: 'div:has(> span)', count: 1 });
    } else {
      broken.push({ css: 'div:has(> span)', count: 0 });
    }

    // Method 3: button or a element with text
    let foundBtn = false;
    document.querySelectorAll('button, a, [role="button"]').forEach(el => {
      const text = (el.innerText || '').trim();
      if (chatPattern.test(text)) {
        foundBtn = true;
      }
    });
    if (foundBtn) {
      working.push({ css: "button:has-text('新对话')", count: 1 });
    } else {
      broken.push({ css: "button:has-text('新对话')", count: 0 });
    }

    results.health.role_checks.new_chat_button = {
      working,
      broken,
      status: working.length > 0 ? (broken.length === 0 ? 'ok' : 'degraded') : 'broken'
    };
  })();

  // ===== 13. Verification detection =====
  const verifyPhrases = /人机验证|完成安全验证|异常访问|滑动验证|拖动滑块/i;
  const bodyText = (document.body && document.body.innerText) || '';
  const hasVerifyPhrase = verifyPhrases.test(bodyText);
  const hasVerifyFrame = !!document.querySelector('iframe[src*="captcha"], iframe[src*="verify"]');
  const modalText = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .semi-modal, .modal'))
    .map(el => (el.innerText || '').substring(0, 200))
    .join(' | ');

  results.verification = {
    detected: hasVerifyFrame || hasVerifyPhrase,
    hasVerifyFrame: hasVerifyFrame,
    hasVerifyPhrase: hasVerifyPhrase,
    modalText: modalText.substring(0, 500)
  };

  return results;
}`;
