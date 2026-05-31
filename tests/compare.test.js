import { describe, expect, it } from 'vitest';
import { compareAnalysis, formatComparisonReport } from '../lib/compare.mjs';

const mockBaseline = {
    site: 'doubao',
    version: 1,
    updated: '2026-01-01T00:00:00Z',
    roles: {
        message_list_container: {
            description: 'Scrollable chat message list',
            selectors: [
                { css: '[class*="message-list"]', type: 'class-substring', priority: 1, stability: 'medium' },
                { css: '[data-testid="message-list"]', type: 'data-testid', priority: 2, stability: 'high' }
            ]
        },
        send_button: {
            description: 'Send button',
            selectors: [
                { css: 'button#flow-end-msg-send', type: 'id', priority: 1, stability: 'low' },
                { css: 'button[type="submit"]', type: 'attribute', priority: 2, stability: 'high' }
            ]
        }
    }
};

function makeHealthyAnalysis() {
    return {
        url: 'https://www.doubao.com/chat/123',
        health: {
            role_checks: {
                message_list_container: {
                    status: 'ok',
                    working: [
                        { css: '[class*="message-list"]', count: 1 },
                        { css: '[data-testid="message-list"]', count: 1 }
                    ],
                    broken: []
                },
                send_button: {
                    status: 'ok',
                    working: [
                        { css: 'button#flow-end-msg-send', count: 1 },
                        { css: 'button[type="submit"]', count: 1 }
                    ],
                    broken: []
                }
            }
        }
    };
}

function makeDegradedAnalysis() {
    return {
        url: 'https://www.doubao.com/chat/123',
        health: {
            role_checks: {
                message_list_container: {
                    status: 'degraded',
                    working: [{ css: '[class*="message-list"]', count: 1 }],
                    broken: [{ css: '[data-testid="message-list"]', count: 0 }]
                },
                send_button: {
                    status: 'broken',
                    working: [],
                    broken: [
                        { css: 'button#flow-end-msg-send', count: 0 },
                        { css: 'button[type="submit"]', count: 0 }
                    ]
                }
            }
        }
    };
}

describe('compareAnalysis', () => {
    it('reports all roles healthy when all selectors match', () => {
        const report = compareAnalysis(makeHealthyAnalysis(), mockBaseline);
        expect(report.overallStatus).toBe('healthy');
        expect(report.summary.brokenRoles).toBe(0);
    });

    it('reports critical when a role has all selectors broken', () => {
        const report = compareAnalysis(makeDegradedAnalysis(), mockBaseline);
        expect(report.overallStatus).toBe('critical');
        expect(report.summary.brokenRoles).toBeGreaterThan(0);
    });

    it('reports degraded when a role has working and broken selectors', () => {
        const report = compareAnalysis(makeDegradedAnalysis(), mockBaseline);
        const msgRole = report.roles.message_list_container;
        expect(msgRole.status).toBe('degraded');
        expect(msgRole.working).toBe(1);
        expect(msgRole.broken).toBe(1);
    });

    it('reports broken when all selectors for a role are missing', () => {
        const report = compareAnalysis(makeDegradedAnalysis(), mockBaseline);
        const sendRole = report.roles.send_button;
        expect(sendRole.status).toBe('broken');
        expect(sendRole.working).toBe(0);
        expect(sendRole.broken).toBe(2);
    });

    it('detects verification challenges', () => {
        const analysis = {
            ...makeHealthyAnalysis(),
            verification: { detected: true }
        };
        const report = compareAnalysis(analysis, mockBaseline);
        expect(report.verificationDetected).toBe(true);
    });

    it('handles empty analysis gracefully', () => {
        const report = compareAnalysis(null, mockBaseline);
        expect(report.overallStatus).toBe('critical');
    });

    it('handles analysis without health data', () => {
        const analysis = { url: 'https://example.com' };
        const report = compareAnalysis(analysis, mockBaseline);
        expect(report.overallStatus).toBe('critical');
    });
});

const mockV2Baseline = {
    site: 'doubao',
    schema_version: 2,
    updated: '2026-05-25T00:00:00Z',
    source: {
        adapter_path: '~/.npm-global/lib/node_modules/@jackwener/opencli/clis/doubao/',
        source_files: ['utils.js'],
        extraction_method: 'manual',
        extraction_date: '2026-01-01T00:00:00Z'
    },
    roles: {
        message_list_container: {
            description: 'Scrollable chat message list',
            category: 'container',
            selectors: [
                { css: '[class*="message-list"]', type: 'class-substring', priority: 1, stability: 'medium', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] },
                { css: '[data-testid="message-list"]', type: 'data-testid', priority: 2, stability: 'high', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] }
            ]
        },
        send_button: {
            description: 'Send button',
            category: 'button',
            selectors: [
                { css: 'button#flow-end-msg-send', type: 'id', priority: 1, stability: 'low', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] },
                { css: 'button[type="submit"]', type: 'attribute', priority: 2, stability: 'high', source: { file: 'utils.js', extracted: '2026-01-01T00:00:00Z' }, status: 'unknown', history: [] }
            ]
        }
    },
    snapshots: { latest: null, history: [] }
};

describe('compareAnalysis with v2 baseline', () => {
    it('works with v2 schema_version field', () => {
        const report = compareAnalysis(makeHealthyAnalysis(), mockV2Baseline);
        expect(report.overallStatus).toBe('healthy');
        expect(report.baselineVersion).toBe(2);
    });

    it('falls back to version field when schema_version is missing', () => {
        const hybrid = { ...mockV2Baseline };
        delete hybrid.schema_version;
        hybrid.version = 1;
        const report = compareAnalysis(makeHealthyAnalysis(), hybrid);
        expect(report.baselineVersion).toBe(1);
    });

    it('defaults version to 1 when both fields are missing', () => {
        const hybrid = { ...mockV2Baseline };
        delete hybrid.schema_version;
        const report = compareAnalysis(makeHealthyAnalysis(), hybrid);
        expect(report.baselineVersion).toBe(1);
    });

    it('handles v2 selectors with extra fields (source, status, history)', () => {
        const report = compareAnalysis(makeHealthyAnalysis(), mockV2Baseline);
        expect(report.overallStatus).toBe('healthy');
        expect(report.roles.send_button.selectors[0].css).toBe('button#flow-end-msg-send');
    });

    it('detects new selectors against v2 baseline', () => {
        const analysis = makeHealthyAnalysis();
        analysis.selectors = {
            data_test_ids: { 'new-chat-btn': 1 },
            id_selectors: {}
        };
        const report = compareAnalysis(analysis, mockV2Baseline);
        expect(report.newSelectors.data_test_ids.length).toBeGreaterThan(0);
        expect(report.newSelectors.data_test_ids[0].css).toBe('[data-testid="new-chat-btn"]');
    });
});

describe('normalizeCss edge cases', () => {
    it('handles selectors with single quotes', () => {
        const analysis = {
            url: 'https://example.com',
            health: {
                role_checks: {
                    test_role: {
                        status: 'ok',
                        working: [{ css: "[class*='foo']", count: 1 }],
                        broken: []
                    }
                }
            }
        };
        const baseline = {
            site: 'test',
            roles: {
                test_role: {
                    description: '',
                    selectors: [{ css: '[class*="foo"]', type: 'class-substring', priority: 1, stability: 'medium' }]
                }
            }
        };
        const report = compareAnalysis(analysis, baseline);
        expect(report.roles.test_role.status).toBe('ok');
    });

    it('handles null css gracefully', () => {
        const analysis = {
            url: 'https://example.com',
            health: {
                role_checks: {
                    test_role: {
                        status: 'ok',
                        details: [{ css: null, count: 0 }],
                        working: [],
                        broken: []
                    }
                }
            }
        };
        const baseline = {
            site: 'test',
            roles: {
                test_role: {
                    description: '',
                    selectors: [{ css: '[class*="foo"]', type: 'class-substring', priority: 1, stability: 'medium' }]
                }
            }
        };
        const report = compareAnalysis(analysis, baseline);
        expect(report.roles.test_role.status).toBe('broken');
    });
});

describe('formatComparisonReport', () => {
    it('produces readable output for degraded state', () => {
        const report = compareAnalysis(makeDegradedAnalysis(), mockBaseline);
        const text = formatComparisonReport(report);
        expect(text).toContain('CRITICAL');
        expect(text).toContain('send_button');
        expect(text).toContain('BROKEN');
        expect(text).toContain('button#flow-end-msg-send');
    });

    it('produces readable output for healthy state', () => {
        const report = compareAnalysis(makeHealthyAnalysis(), mockBaseline);
        const text = formatComparisonReport(report);
        expect(text).toContain('HEALTHY');
    });
});
