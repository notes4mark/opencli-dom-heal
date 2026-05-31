/**
 * Candidate selector scoring engine.
 * Ranks replacement selectors for a broken role by multi-factor analysis.
 *
 * Factors:
 *   specificity  — selector type (data-testid > id > aria > semantic class > generic > hashed)
 *   uniqueness   — penalty for matching too many elements, bonus for exactly 1
 *   textMatch    — button/placeholder text matches expected role pattern
 *   historical   — bonus if this selector was previously used for this role
 *   visibility   — gate: invisible candidates are disqualified
 */

/**
 * Classify selector type and return base specificity score (0–10).
 */
export function classifySelector(css) {
  if (!css || typeof css !== 'string') return { type: 'unknown', score: 0 };

  // data-testid selectors: exact match or contains/wildcard operators
  if (/^\[data-testid[*~|^$]?=/.test(css) || /^\[data-testid\]/.test(css)) {
    return { type: 'data-testid', score: 10 };
  }
  // Pure ID selector (no attribute brackets)
  if (/^#[a-zA-Z]/.test(css) && !css.includes('[')) {
    return { type: 'id', score: 8 };
  }
  if (/\[aria-label/.test(css)) {
    return { type: 'aria-label', score: 6 };
  }
  // data-* attribute (but not data-testid, already handled above)
  if (/^\[data-/.test(css)) {
    return { type: 'data-attribute', score: 7 };
  }
  if (/\[role=/.test(css)) {
    return { type: 'role', score: 7 };
  }
  if (/\[type=/.test(css) || /\[placeholder/.test(css) || /\[href/.test(css)) {
    return { type: 'attribute', score: 6 };
  }
  // :has-text pseudo-selector
  if (css.includes(':has-text')) {
    return { type: 'text', score: 5 };
  }
  // Tag with attribute brackets (e.g., button[type="submit"], textarea[placeholder], div[role])
  if (/^(button|textarea|a|div)\[/.test(css)) {
    return { type: 'tag-with-attribute', score: 5 };
  }
  // Class substring selectors ([class*="..."]) — check before clean class
  if (/\[class\*=['"]/.test(css)) {
    const match = css.match(/\[class\*=['"]([^'"]+)['"]\]/);
    if (match) {
      const sub = match[1];
      if (/^[a-f0-9_-]{6,}$/.test(sub)) return { type: 'class-hashed', score: 1 };
      if (/[a-z]{3,}/.test(sub)) return { type: 'class-substring', score: 3 };
    }
    return { type: 'class-substring', score: 2 };
  }
  // Plain tag selector (e.g., 'textarea', 'button') — must check before class-based logic
  if (/^[a-z][a-z0-9]*$/i.test(css)) {
    return { type: 'tag', score: 1 };
  }
  // Semantic class: contains readable words (not hashed)
  const cleanClass = css.replace(/^\./, '').replace(/\[class[*^$]?=['"]/, '').replace(/['"]\]$/, '');
  if (/[a-z]{4,}/.test(cleanClass) && !/^[a-f0-9]{6,}$/.test(cleanClass)) {
    return { type: 'class-semantic', score: 4 };
  }
  return { type: 'generic', score: 1 };
}

/**
 * Check if a className string looks like a CSS module hash (randomized per build).
 */
export function isHashedClass(className) {
  if (!className || className.length < 6) return false;
  const clean = className.replace(/^\./, '');
  // Pure hex-like (underscore-prefixed optional)
  if (/^_?[a-f0-9]{6,}$/.test(clean)) return true;
  // Underscore-prefixed followed by uppercase (e.g., _2bd7b35, _PvPoAn)
  if (/^_[A-Z]/.test(clean)) return true;
  // Semantic prefix + random-looking suffix: contains digit or uppercase in the hash part
  // (e.g., container-h3Yzeb, message-zLoNs1, item-kDun2N) but NOT message-list or flow-markdown-body
  if (/^[a-z]+[-_][a-zA-Z0-9]*[0-9A-Z][a-zA-Z0-9]*$/.test(clean)) return true;
  return false;
}

/**
 * Compute uniqueness score based on element count.
 * @param {number} count - How many elements match this selector
 * @returns {{ score: number, label: string }}
 */
export function uniquenessScore(count) {
  if (count === 1) return { score: 3, label: 'exact-1' };
  if (count === 2 || count === 3) return { score: 1, label: 'few' };
  if (count >= 4 && count <= 10) return { score: 0, label: 'many' };
  if (count > 10) return { score: -2, label: 'too-many' };
  return { score: 0, label: 'unknown' };
}

/**
 * Compute text-match score. Checks if element text/placeholder/aria-label
 * matches expected patterns for the role.
 * @param {object} candidate - Candidate element from analysis output
 * @param {string} roleName - Role being healed (e.g., 'send_button', 'composer_textarea')
 */
export function textMatchScore(candidate, roleName) {
  const patterns = {
    send_button: [/发送|Send|Submit/i],
    composer_textarea: [/发消息|Message|输入|Type|Ask|DeepSeek/i],
    new_chat_button: [/新对话|New Chat|创建/i],
    captcha_indicator: [/验证码|captcha|verify|安全验证/i],
    conversation_link: [/\/chat\//],
    message_item: [],
    message_list_container: [],
    assistant_message: [],
    user_message: [],
    message_text: [],
    meeting_card: [],
    thinking_container: [/think|思考|reasoning/i],
    model_radio: [/instant|expert|vision|即时|专家/i],
    feature_toggle: [/search|think|搜索|思考/i],
    login_indicator: [/avatar|头像/i],
    markdown_content: []
  };

  const rolePatterns = patterns[roleName] || [];
  if (rolePatterns.length === 0) return 0;

  const searchText = [
    candidate.text || '',
    candidate.placeholder || '',
    candidate.ariaLabel || '',
    candidate.title || '',
    candidate.css || ''
  ].join(' ');

  for (const pat of rolePatterns) {
    if (pat.test(searchText)) return 5;
  }
  return 0;
}

/**
 * Historical bonus: +2 if this selector appears in the existing baseline for this role.
 */
export function historicalScore(candidateCss, existingSelectors) {
  if (!existingSelectors || existingSelectors.length === 0) return 0;
  const match = existingSelectors.some(s => s.css === candidateCss);
  return match ? 2 : 0;
}

/**
 * Score a single candidate selector for a given role.
 * @param {object} candidate - Candidate from analysis output (must have css, count, visible, and optional text/placeholder)
 * @param {string} roleName - The role being healed
 * @param {object[]} existingSelectors - Current baseline selectors for this role
 * @returns {{ totalScore: number, breakdown: object, disqualified: boolean, reason: string }}
 */
export function scoreCandidate(candidate, roleName, existingSelectors = []) {
  // Visibility gate
  if (candidate.visible === false) {
    return {
      totalScore: 0,
      breakdown: {},
      disqualified: true,
      reason: 'Element is not visible (offsetParent is null or zero-size rect)'
    };
  }

  const classification = classifySelector(candidate.css);
  const uniqueness = uniquenessScore(candidate.count || 1);
  const textMatch = textMatchScore(candidate, roleName);
  const historical = historicalScore(candidate.css, existingSelectors);

  // Penalize hashed classes further
  let hashedPenalty = 0;
  if (candidate.class && isHashedClass(candidate.class)) {
    hashedPenalty = -3;
  }
  // Also check if the CSS itself contains a hashed-looking class
  if (isHashedClass(candidate.css)) {
    hashedPenalty = Math.min(hashedPenalty, -3);
  }

  const totalScore = classification.score + uniqueness.score + textMatch + historical + hashedPenalty;

  return {
    totalScore: Math.max(0, totalScore),
    breakdown: {
      specificity: { score: classification.score, type: classification.type },
      uniqueness: { score: uniqueness.score, label: uniqueness.label, count: candidate.count || 1 },
      textMatch: { score: textMatch },
      historical: { score: historical },
      hashedPenalty: { score: hashedPenalty }
    },
    disqualified: false,
    reason: ''
  };
}

/**
 * Rank all candidates for a role and return the top suggestions.
 * @param {object[]} candidates - Array of candidate elements from analysis
 * @param {string} roleName - Role being healed
 * @param {object[]} existingSelectors - Current baseline selectors
 * @param {object} options
 * @param {number} options.topN - Number of top candidates to return (default 3)
 * @returns {object[]} Ranked candidates with scores, sorted by totalScore descending
 */
export function rankCandidates(candidates, roleName, existingSelectors = [], options = {}) {
  const { topN = 3 } = options;

  const scored = candidates
    .map(c => ({
      ...c,
      ...scoreCandidate(c, roleName, existingSelectors)
    }))
    .filter(c => !c.disqualified)
    .sort((a, b) => b.totalScore - a.totalScore);

  return scored.slice(0, topN);
}

/**
 * Generate a healing recommendation for a broken role.
 * @param {object} analysisResult - Full analysis output (snapshot format)
 * @param {string} roleName - Role to heal
 * @param {object[]} existingSelectors - Current baseline selectors for this role
 * @returns {{ role: string, status: string, topCandidate: object|null, alternatives: object[] }}
 */
export function recommendHeal(analysisResult, roleName, existingSelectors = []) {
  // Map roles to candidate categories in the analysis output
  const roleToCategory = {
    composer_textarea: 'text_inputs',
    send_button: 'buttons',
    new_chat_button: 'buttons',
    message_item: 'message_blocks',
    message_list_container: 'scroll_containers',
    conversation_link: 'links',
    assistant_message: 'message_blocks',
    user_message: 'message_blocks',
    captcha_indicator: null // handled separately
  };

  const category = roleToCategory[roleName];
  if (!category || !analysisResult.candidates || !analysisResult.candidates[category]) {
    return { role: roleName, status: 'no_candidates', topCandidate: null, alternatives: [] };
  }

  // Normalize candidate field names: some analysis scripts use 'selector' or 'href' instead of 'css'
  const candidates = analysisResult.candidates[category].map(c => ({
    ...c,
    css: c.css || c.selector || c.href || '',
    count: c.count || 1,
    visible: c.visible !== undefined ? c.visible : true
  }));
  const ranked = rankCandidates(candidates, roleName, existingSelectors, { topN: 5 });

  return {
    role: roleName,
    status: ranked.length > 0 ? 'candidates_found' : 'no_viable_candidates',
    topCandidate: ranked[0] || null,
    alternatives: ranked.slice(1)
  };
}
