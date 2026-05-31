/**
 * Generic DOM analysis script generator.
 * Takes a v2 baseline and produces an injectable JS IIFE that catalogs the page.
 *
 * The baseline's source.analysis_hints block drives all site-specific behavior.
 * Without hints, sensible generic defaults are used — any site with a v2 baseline
 * works immediately. Adding hints progressively improves candidate quality.
 *
 * Hints schema (all optional):
 *   link_pattern:             CSS selector for relevant links (default: 'a[href]')
 *   link_exclude_paths:       URL path prefixes to ignore
 *   link_id_regex:            JS regex string to extract IDs from hrefs
 *   message_item_selectors:   CSS selectors that match message blocks
 *   message_role_heuristic:   "bubble" | "class-count" | null
 *   user_bubble_selectors:    Child selectors indicating a user message
 *   assistant_bubble_selectors: Child selectors indicating an assistant message
 *   button_scope_selector:    Scope button search to this container
 *   button_css_selectors:     Custom button selectors (default: 'button, [role="button"]')
 *   send_button_patterns:     Regex patterns for send-like buttons
 *   exclude_button_patterns:  Regex patterns for non-action buttons to exclude
 *   content_selectors:        Prose/markdown content element selectors
 *   verification_phrases:     Text patterns for CAPTCHA detection
 *   verification_frame_patterns: URL substrings for CAPTCHA iframes
 *   extra_selectors:          Named extra collectors (currently supports: "ds_classes")
 *
 * Usage:
 *   import { generateAnalysisScript } from './generate-analysis.mjs';
 *   const script = generateAnalysisScript(baseline);
 *   const result = await page.evaluate(script);
 */

function esc(str) {
  return JSON.stringify(str);
}

/**
 * Build the health checks object literal from baseline roles.
 */
function buildHealthChecksLiteral(roles) {
  const entries = Object.entries(roles).map(([name, def]) => {
    const selectors = (def.selectors || []).map(s => s.css);
    return `${esc(name)}: checkRole(${esc(name)}, ${esc(selectors)})`;
  });
  return `{\n    ${entries.join(',\n    ')}\n  }`;
}

function buildExtraCollectors(hints) {
  if (!hints?.extra_selectors?.length) return '';

  const parts = [];
  for (const extra of hints.extra_selectors) {
    if (extra === 'ds_classes') {
      parts.push(`  // DeepSeek-style ds- prefixed class names
  const dsClasses = new Set();
  document.querySelectorAll('[class*="ds-"]').forEach(el => {
    if (typeof el.className !== 'string') return;
    el.className.split(/\\s+/).forEach(c => {
      if (c.startsWith('ds-')) dsClasses.add(c);
    });
  });
  results.selectors.ds_classes = Array.from(dsClasses).sort();`);
    }
  }

  return parts.length ? '\n' + parts.join('\n') + '\n' : '';
}

function hasCategory(roles, category) {
  return Object.values(roles).some(r => r.category === category);
}

function buildButtonSection(hints, hasButtons, hasInteractive) {
  if (!hasButtons && !hasInteractive) return '';

  const scopeSel = hints.button_scope_selector || null;
  const cssSels = hints.button_css_selectors || ['button', '[role="button"]'];
  const sendPats = hints.send_button_patterns || [];
  const excludePats = hints.exclude_button_patterns || [];
  const hasPatterns = sendPats.length > 0 || excludePats.length > 0;

  const selectorString = cssSels.join(', ');

  let lines = [];
  lines.push(`  // ===== Candidates: buttons =====`);

  if (hasPatterns) {
    lines.push(`  const sendPattern = /(${sendPats.join('|')})/i;`);
  }
  if (excludePats.length) {
    lines.push(`  const excludeBtnPattern = /(${excludePats.join('|')})/i;`);
  }
  if (scopeSel) {
    lines.push(`  const composerArea = document.querySelector(${esc(scopeSel)});
  const btnScope = composerArea || document.body;`);
    lines.push('');
    lines.push(`  btnScope.querySelectorAll(${esc(selectorString)}).forEach(el => {`);
  } else {
    lines.push(`  document.querySelectorAll(${esc(selectorString)}).forEach(el => {`);
  }

  lines.push(`    const text = (el.innerText || el.textContent || '').trim();
    const ariaLabel = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';`);

  if (hasPatterns) {
    lines.push(`    const combined = (text + ' ' + ariaLabel + ' ' + title).toLowerCase();
    const isSendLike = sendPattern.test(combined);`);
  }
  if (excludePats.length) {
    lines.push(`    const isExcluded = excludeBtnPattern.test(combined);`);
  }

  // Build the push object
  const fields = [
    `tag: el.tagName`,
    `id: el.id || null`,
    `class: shortClass(el, 100)`,
    `text: text.substring(0, 50)`,
    `ariaLabel: ariaLabel.substring(0, 50)`,
    `title: title.substring(0, 50)`,
    `type: el.getAttribute('type') || null`,
    `disabled: el.disabled || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true'`,
    `visible: isVisible(el)`,
    `depth: computeDepth(el)`,
  ];

  if (sendPats.length) fields.push(`isSendLike: isSendLike`);
  if (excludePats.length) fields.push(`isExcluded: isExcluded`);

  fields.push(`css: (el.id ? '#' + el.id : el.tagName.toLowerCase()) +
      (el.getAttribute('type') ? '[type="' + el.getAttribute('type') + '"]' : '')`);

  lines.push(`    results.candidates.buttons.push({
      ${fields.join(',\n      ')}
    });`);
  lines.push(`  });`);

  return lines.join('\n');
}

function buildMessageBlockSection(hints, hasContent, hasContainers) {
  if (!hasContent && !hasContainers) return '';

  const msgSelectors = hints.message_item_selectors || ['[class*="message"]', '[data-message-id]'];
  const heuristic = hints.message_role_heuristic || null;
  const userBubbleSels = hints.user_bubble_selectors || [];
  const assistantBubbleSels = hints.assistant_bubble_selectors || [];

  let lines = [];
  lines.push(`  // ===== Candidates: message blocks =====`);
  lines.push(`  const msgSelectors = ${esc(msgSelectors)};`);
  lines.push(`  msgSelectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      const text = (el.innerText || '').trim();
      if (text.length < 1) return;`);

  if (heuristic === 'bubble' && (userBubbleSels.length || assistantBubbleSels.length)) {
    const userSel = userBubbleSels.join(', ');
    const asstSel = assistantBubbleSels.join(', ');
    lines.push(`      const hasUserBubble = ${userBubbleSels.length ? `!!el.querySelector(${esc(userSel)})` : 'false'};`);
    lines.push(`      const hasAssistantBubble = ${assistantBubbleSels.length ? `!!el.querySelector(${esc(asstSel)})` : 'false'};`);
    lines.push(`      let role = 'unknown';
      if (hasUserBubble && !hasAssistantBubble) role = 'User';
      else if (hasAssistantBubble && !hasUserBubble) role = 'Assistant';
      else if (hasUserBubble) role = 'User';
      else if (hasAssistantBubble) role = 'Assistant';`);

    lines.push(`      results.candidates.message_blocks.push({
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
      });`);

  } else if (heuristic === 'class-count') {
    lines.push(`      const classCount = el.className && typeof el.className === 'string'
        ? el.className.split(/\\s+/).length : 0;
      const role = classCount > 2 ? 'User' : 'Assistant';`);
    lines.push(`      results.candidates.message_blocks.push({
        selector: sel,
        tag: el.tagName,
        class: shortClass(el, 150),
        role: role,
        classCount: classCount,
        textPreview: text.substring(0, 300),
        textLength: text.length,
        childCount: el.children.length,
        visible: isVisible(el),
        depth: computeDepth(el)
      });`);

  } else {
    // Generic: no role detection
    lines.push(`      results.candidates.message_blocks.push({
        selector: sel,
        tag: el.tagName,
        class: shortClass(el, 150),
        textPreview: text.substring(0, 200),
        textLength: text.length,
        childCount: el.children.length,
        visible: isVisible(el),
        depth: computeDepth(el)
      });`);
  }

  lines.push(`    });
  });`);

  return lines.join('\n');
}

function buildLinkSection(hints, hasLinks) {
  if (!hasLinks) return '';

  const linkPattern = hints.link_pattern || 'a[href]';
  const excludePaths = hints.link_exclude_paths || [];
  const idRegex = hints.link_id_regex || null;

  let lines = [];
  lines.push(`  // ===== Candidates: links =====`);
  if (excludePaths.length) {
    lines.push(`  const excludePaths = ${esc(excludePaths)};`);
  }
  lines.push(`  document.querySelectorAll(${esc(linkPattern)}).forEach(a => {
    const href = a.getAttribute('href') || '';
    if (!href || href === '#') return;`);
  if (excludePaths.length) {
    lines.push(`    if (excludePaths.some(p => href.startsWith(p))) return;`);
  }
  if (idRegex) {
    // The regex is stored as a string like "/\\/chat\\/(\\d{10,})/"
    lines.push(`    const match = href.match(${idRegex});`);
    lines.push(`    results.candidates.links.push({
      href: href,
      id: match ? match[1] : null,
      text: (a.textContent || a.innerText || '').trim().substring(0, 200),
      visible: isVisible(a),
      depth: computeDepth(a)
    });`);
  } else {
    lines.push(`    results.candidates.links.push({
      href: href,
      text: (a.textContent || a.innerText || '').trim().substring(0, 200),
      visible: isVisible(a),
      depth: computeDepth(a)
    });`);
  }
  lines.push(`  });`);

  return lines.join('\n');
}

function buildContentSection(hints, hasContent) {
  if (!hasContent) return '';

  const contentSels = hints.content_selectors || [];
  if (!contentSels.length) return '';

  let lines = [];
  lines.push(`  // ===== Candidates: prose/markdown content =====`);
  lines.push(`  document.querySelectorAll(${esc(contentSels.join(', '))}).forEach((el, i) => {
    results.candidates.prose_elements = results.candidates.prose_elements || [];
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
  });`);

  return lines.join('\n');
}

function buildInteractiveSection(hints, hasInteractive) {
  if (!hasInteractive) return '';

  let lines = [];
  lines.push(`  // ===== Candidates: interactive controls =====`);
  lines.push(`  document.querySelectorAll('[role="radio"], [role="switch"], [role="checkbox"], [aria-checked]').forEach(el => {
    results.candidates.buttons.push({
      tag: el.tagName,
      id: el.id || null,
      class: shortClass(el, 100),
      text: (el.innerText || '').trim().substring(0, 50),
      ariaLabel: (el.getAttribute('aria-label') || '').substring(0, 50),
      role: el.getAttribute('role') || null,
      checked: el.getAttribute('aria-checked') || null,
      visible: isVisible(el),
      depth: computeDepth(el),
      css: (el.id ? '#' + el.id : el.tagName.toLowerCase() + '[role="' + (el.getAttribute('role') || '') + '"]')
    });
  });`);

  return lines.join('\n');
}

function buildVerificationSection(hints) {
  const phrases = hints.verification_phrases || [];
  if (!phrases.length) return '';

  const framePats = hints.verification_frame_patterns || ['captcha', 'verify'];
  const frameSelector = framePats.map(p => `iframe[src*="${p}"]`).join(', ');

  return `
  // ===== Verification detection =====
  const verifyPhrases = ${esc(phrases)};
  const phraseRegex = new RegExp(verifyPhrases.join('|'), 'i');
  const bodyText = (document.body && document.body.innerText) || '';
  const hasVerifyPhrase = phraseRegex.test(bodyText);
  const hasVerifyFrame = !!document.querySelector(${esc(frameSelector)});
  results.verification = {
    detected: hasVerifyFrame || hasVerifyPhrase,
    hasVerifyFrame: hasVerifyFrame,
    hasVerifyPhrase: hasVerifyPhrase
  };`;
}

/**
 * Generate a DOM analysis script from a v2 baseline.
 * Every site-specific behavior is driven by source.analysis_hints.
 *
 * @param {object} baseline - v2 baseline with roles, source.analysis_hints
 * @returns {string} Injectable JS IIFE string
 */
export function generateAnalysisScript(baseline) {
  const roles = baseline.roles || {};
  const hints = baseline.source?.analysis_hints || {};

  const healthChecksLiteral = buildHealthChecksLiteral(roles);
  const extraCollectors = buildExtraCollectors(hints);

  const hasButtons = hasCategory(roles, 'button');
  const hasInputs = hasCategory(roles, 'input');
  const hasLinks = hasCategory(roles, 'link');
  const hasContainers = hasCategory(roles, 'container');
  const hasContent = hasCategory(roles, 'content');
  const hasInteractive = hasCategory(roles, 'interactive');

  // Build all candidate sections
  const sections = [];

  // Text inputs — always scan
  sections.push(`  // ===== Candidates: text inputs =====
  const inputSelectors = ['textarea', '[contenteditable="true"]', '[role="textbox"]', 'input[type="text"]'];
  const seenInputs = new Set();
  inputSelectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      if (seenInputs.has(el)) return;
      seenInputs.add(el);
      const placeholder = el.placeholder || el.getAttribute('placeholder') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      results.candidates.text_inputs.push({
        css: (el.id ? '#' + el.id : el.tagName.toLowerCase()) +
          (placeholder ? '[placeholder*="' + placeholder.substring(0, 10) + '"]' : ''),
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
  });`);

  // Buttons
  const btnSection = buildButtonSection(hints, hasButtons, hasInteractive);
  if (btnSection) sections.push(btnSection);

  // Interactive
  const intSection = buildInteractiveSection(hints, hasInteractive);
  if (intSection) sections.push(intSection);

  // Links
  const linkSection = buildLinkSection(hints, hasLinks);
  if (linkSection) sections.push(linkSection);

  // Message blocks
  const msgSection = buildMessageBlockSection(hints, hasContent, hasContainers);
  if (msgSection) sections.push(msgSection);

  // Scroll containers
  if (hasContainers) {
    sections.push(`  // ===== Candidates: scroll containers =====
  scrollable.slice(0, 5).forEach(sc => {
    const match = sc.class.match(/[a-zA-Z0-9_-]+/);
    sc.selector = '[class*="' + (match ? match[0] : 'unknown') + '"]';
    results.candidates.scroll_containers.push(sc);
  });`);
  }

  // Content / prose
  const contentSection = buildContentSection(hints, hasContent);
  if (contentSection) sections.push(contentSection);

  // Verification
  const verifySection = buildVerificationSection(hints);

  const candidatesJs = sections.join('\n\n');

  return `() => {
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

  // ===== 5. All element IDs =====
  const idMap = {};
  document.querySelectorAll('[id]').forEach(el => {
    idMap[el.id] = (idMap[el.id] || 0) + 1;
  });
  results.selectors.id_selectors = idMap;

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
${extraCollectors}
${candidatesJs}
${verifySection}
  // ===== Role health checks =====
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

  results.health.role_checks = ${healthChecksLiteral};

  return results;
}`;
}
