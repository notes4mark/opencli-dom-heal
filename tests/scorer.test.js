import { describe, expect, it } from 'vitest';
import {
    classifySelector,
    isHashedClass,
    uniquenessScore,
    textMatchScore,
    historicalScore,
    scoreCandidate,
    rankCandidates,
    recommendHeal
} from '../lib/scorer.mjs';

describe('classifySelector', () => {
    it('scores data-testid highest (10)', () => {
        expect(classifySelector('[data-testid="message-list"]')).toEqual({ type: 'data-testid', score: 10 });
        expect(classifySelector('[data-testid*="message"]')).toEqual({ type: 'data-testid', score: 10 });
    });

    it('scores id selectors (8)', () => {
        expect(classifySelector('#flow-end-msg-send')).toEqual({ type: 'id', score: 8 });
    });

    it('scores aria-label selectors (6)', () => {
        expect(classifySelector('[aria-label*="发消息"]')).toEqual({ type: 'aria-label', score: 6 });
    });

    it('scores semantic class selectors (4)', () => {
        expect(classifySelector('.flow-markdown-body')).toEqual({ type: 'class-semantic', score: 4 });
    });

    it('scores class-substring selectors (2-3)', () => {
        expect(classifySelector('[class*="message-list"]').type).toBe('class-substring');
        expect(classifySelector('[class*="message-list"]').score).toBeGreaterThanOrEqual(2);
    });

    it('scores tag-only selectors low (1)', () => {
        expect(classifySelector('textarea')).toEqual({ type: 'tag', score: 1 });
    });

    it('penalizes hashed class substrings', () => {
        const result = classifySelector('[class*="_2bd7b35"]');
        expect(result.type).toBe('class-hashed');
        expect(result.score).toBe(1);
    });

    it('scores text-selectors (5)', () => {
        expect(classifySelector("button:has-text('新对话')")).toEqual({ type: 'text', score: 5 });
    });
});

describe('isHashedClass', () => {
    it('detects underscore-prefixed hex hashes (_2bd7b35 style)', () => {
        expect(isHashedClass('_2bd7b35')).toBe(true);
        expect(isHashedClass('_a3f2d50e')).toBe(true);
    });

    it('detects pure hex-like strings', () => {
        expect(isHashedClass('a3f2d50e')).toBe(true);
    });

    it('rejects semantic class names', () => {
        expect(isHashedClass('flow-markdown-body')).toBe(false);
        expect(isHashedClass('message-list')).toBe(false);
        expect(isHashedClass('ds-message')).toBe(false);
    });

    it('rejects short names', () => {
        expect(isHashedClass('btn')).toBe(false);
    });

    it('detects mixed-style hashed classes like container-h3Yzeb', () => {
        expect(isHashedClass('container-h3Yzeb')).toBe(true);
    });
});

describe('uniquenessScore', () => {
    it('gives +3 for exactly 1 match', () => {
        expect(uniquenessScore(1)).toEqual({ score: 3, label: 'exact-1' });
    });

    it('gives +1 for 2-3 matches', () => {
        expect(uniquenessScore(2)).toEqual({ score: 1, label: 'few' });
        expect(uniquenessScore(3)).toEqual({ score: 1, label: 'few' });
    });

    it('gives 0 for 4-10 matches', () => {
        expect(uniquenessScore(5)).toEqual({ score: 0, label: 'many' });
    });

    it('penalizes >10 matches (-2)', () => {
        expect(uniquenessScore(15)).toEqual({ score: -2, label: 'too-many' });
    });
});

describe('textMatchScore', () => {
    it('matches send button text patterns', () => {
        expect(textMatchScore({ text: '发送' }, 'send_button')).toBe(5);
        expect(textMatchScore({ placeholder: '发消息' }, 'send_button')).toBe(0); // placeholder doesn't match send_button pattern
        expect(textMatchScore({ ariaLabel: 'Send message' }, 'send_button')).toBe(5);
    });

    it('matches composer textarea patterns', () => {
        expect(textMatchScore({ placeholder: '发消息' }, 'composer_textarea')).toBe(5);
        expect(textMatchScore({ placeholder: 'Message DeepSeek' }, 'composer_textarea')).toBe(5);
    });

    it('returns 0 for roles without text patterns', () => {
        expect(textMatchScore({ text: 'anything' }, 'message_item')).toBe(0);
    });

    it('matches captcha patterns', () => {
        expect(textMatchScore({ text: '完成安全验证' }, 'captcha_indicator')).toBe(5);
        expect(textMatchScore({ placeholder: '验证码' }, 'captcha_indicator')).toBe(5);
    });
});

describe('historicalScore', () => {
    it('gives +2 when selector exists in baseline', () => {
        const selectors = [{ css: '#flow-end-msg-send', type: 'id', priority: 1 }];
        expect(historicalScore('#flow-end-msg-send', selectors)).toBe(2);
    });

    it('gives 0 when selector not in baseline', () => {
        expect(historicalScore('#new-send-button', [])).toBe(0);
    });

    it('gives 0 with empty baseline', () => {
        expect(historicalScore('button', null)).toBe(0);
    });
});

describe('scoreCandidate', () => {
    const existingSelectors = [
        { css: '[data-testid="chat_input_input"]', type: 'data-testid', priority: 1 }
    ];

    it('disqualifies invisible candidates', () => {
        const candidate = { css: 'button#send', count: 1, visible: false };
        const result = scoreCandidate(candidate, 'send_button');
        expect(result.disqualified).toBe(true);
        expect(result.reason).toContain('not visible');
    });

    it('scores a data-testid candidate highest', () => {
        const candidate = { css: '[data-testid="chat_input_input"]', count: 1, visible: true };
        const result = scoreCandidate(candidate, 'composer_textarea', existingSelectors);
        expect(result.totalScore).toBeGreaterThanOrEqual(15); // 10 + 3 + 2(historical)
        expect(result.disqualified).toBe(false);
    });

    it('scores an ID candidate well', () => {
        const candidate = { css: '#flow-end-msg-send', count: 1, visible: true };
        const result = scoreCandidate(candidate, 'send_button');
        expect(result.totalScore).toBeGreaterThanOrEqual(11); // 8 + 3
    });

    it('penalizes hashed class candidates', () => {
        const candidate = {
            css: '[class*="_a3f2d50e"]',
            class: '_a3f2d50e',
            count: 1,
            visible: true
        };
        const result = scoreCandidate(candidate, 'message_item');
        expect(result.breakdown.hashedPenalty.score).toBeLessThan(0);
    });

    it('gives a higher score to unique selectors (1 match) than multi-match ones', () => {
        const unique = scoreCandidate(
            { css: 'button#send', count: 1, visible: true },
            'send_button'
        );
        const multi = scoreCandidate(
            { css: 'textarea', count: 15, visible: true },
            'composer_textarea'
        );
        expect(unique.breakdown.uniqueness.score).toBeGreaterThan(multi.breakdown.uniqueness.score);
    });
});

describe('rankCandidates', () => {
    it('returns top N ranked candidates sorted by score', () => {
        const candidates = [
            { css: 'textarea', count: 3, visible: true },
            { css: '[data-testid="chat_input"] textarea', count: 1, visible: true },
            { css: '[class*="_hash"]', class: '_hash12345', count: 1, visible: true }
        ];
        const ranked = rankCandidates(candidates, 'composer_textarea', [], { topN: 3 });
        expect(ranked.length).toBe(3);
        // data-testid scores highest
        expect(ranked[0].css).toBe('[data-testid="chat_input"] textarea');
        // [class*="_hash"] is next (semantic class 4 + unique 3 = 7, no hashed penalty since _hash is short)
        // textarea (tag 1 + few 1 = 2) scores lowest of the three visible candidates
    });

    it('filters out disqualified (invisible) candidates', () => {
        const candidates = [
            { css: 'button#send', count: 1, visible: false },
            { css: 'button[type="submit"]', count: 1, visible: true }
        ];
        const ranked = rankCandidates(candidates, 'send_button');
        expect(ranked.length).toBe(1);
        expect(ranked[0].css).toBe('button[type="submit"]');
    });

    it('returns empty array when all candidates are disqualified', () => {
        const candidates = [
            { css: 'button#send', count: 1, visible: false }
        ];
        const ranked = rankCandidates(candidates, 'send_button');
        expect(ranked.length).toBe(0);
    });
});

describe('recommendHeal', () => {
    it('returns candidates from the correct analysis category', () => {
        const analysis = {
            candidates: {
                buttons: [
                    { css: 'button#flow-end-msg-send', count: 1, visible: true }
                ]
            }
        };
        const result = recommendHeal(analysis, 'send_button', []);
        expect(result.status).toBe('candidates_found');
        expect(result.topCandidate).toBeTruthy();
        expect(result.topCandidate.css).toBe('button#flow-end-msg-send');
    });

    it('handles missing candidate categories gracefully', () => {
        const analysis = { candidates: {} };
        const result = recommendHeal(analysis, 'send_button', []);
        expect(result.status).toBe('no_candidates');
        expect(result.topCandidate).toBeNull();
    });

    it('returns alternatives for multi-candidate results', () => {
        const analysis = {
            candidates: {
                buttons: [
                    { css: '[data-testid="send-btn"]', count: 1, visible: true },
                    { css: 'button[type="submit"]', count: 1, visible: true },
                    { css: 'button[class*="send"]', count: 3, visible: true }
                ]
            }
        };
        const result = recommendHeal(analysis, 'send_button', []);
        expect(result.topCandidate).toBeTruthy();
        expect(result.alternatives.length).toBe(2);
    });
});
