import assert from 'node:assert/strict';
import test from 'node:test';

import { formatOpenCodeStatusBarText, parseOpenCodeUsage, resolveOpenCodeUsageUrl } from './opencodeUsage';

test('OpenCode usage converts rolling weekly and monthly windows into remaining percentages', () => {
    const result = parseOpenCodeUsage({
        usage: {
            rolling: {
                status: 'ok',
                percent: 0,
                resetsAt: '2026-08-12T06:08:28.405Z'
            },
            weekly: {
                status: 'ok',
                percent: 0,
                resetsAt: '2026-08-17T00:00:00.405Z'
            },
            monthly: {
                status: 'ok',
                percent: 27,
                resetsAt: '2026-09-01T05:59:29.405Z'
            }
        }
    });

    assert.deepEqual(result, {
        kind: 'usage',
        usage: {
            windows: [
                {
                    type: 'rolling',
                    usedPercent: 0,
                    remainingPercent: 100,
                    resetAt: '2026-08-12T06:08:28.405Z',
                    status: 'ok'
                },
                {
                    type: 'weekly',
                    usedPercent: 0,
                    remainingPercent: 100,
                    resetAt: '2026-08-17T00:00:00.405Z',
                    status: 'ok'
                },
                {
                    type: 'monthly',
                    usedPercent: 27,
                    remainingPercent: 73,
                    resetAt: '2026-09-01T05:59:29.405Z',
                    status: 'ok'
                }
            ]
        }
    });
});

test('OpenCode usage rejects malformed percent fields', () => {
    const result = parseOpenCodeUsage({
        usage: {
            rolling: {
                status: 'ok',
                percent: '0',
                resetsAt: '2026-08-12T06:08:28.405Z'
            },
            weekly: {
                status: 'ok',
                percent: 0,
                resetsAt: '2026-08-17T00:00:00.405Z'
            },
            monthly: {
                status: 'ok',
                percent: 27,
                resetsAt: '2026-09-01T05:59:29.405Z'
            }
        }
    });

    assert.deepEqual(result, {
        kind: 'invalid',
        error: 'rolling.percent must be a finite number'
    });
});

test('OpenCode usage accepts partial windows when at least one window is present', () => {
    const result = parseOpenCodeUsage({
        usage: {
            rolling: {
                status: 'ok',
                percent: 12,
                resetsAt: '2026-08-12T06:08:28.405Z'
            }
        }
    });

    assert.deepEqual(result, {
        kind: 'usage',
        usage: {
            windows: [
                {
                    type: 'rolling',
                    usedPercent: 12,
                    remainingPercent: 88,
                    resetAt: '2026-08-12T06:08:28.405Z',
                    status: 'ok'
                }
            ]
        }
    });
});

test('OpenCode usage rejects payloads without any windows', () => {
    const result = parseOpenCodeUsage({ usage: {} });

    assert.deepEqual(result, {
        kind: 'invalid',
        error: 'usage must include at least one window'
    });
});

test('OpenCode status bar text falls back to rolling-only remaining percent', () => {
    assert.equal(
        formatOpenCodeStatusBarText('$(gcmp-opencode)', {
            windows: [
                {
                    type: 'rolling',
                    usedPercent: 12,
                    remainingPercent: 88,
                    resetAt: '2026-08-12T06:08:28.405Z',
                    status: 'ok'
                }
            ]
        }),
        '$(gcmp-opencode) 88%'
    );
});

test('OpenCode status bar text falls back to weekly-only remaining percent', () => {
    assert.equal(
        formatOpenCodeStatusBarText('$(gcmp-opencode)', {
            windows: [
                {
                    type: 'weekly',
                    usedPercent: 36,
                    remainingPercent: 64,
                    resetAt: '2026-08-17T00:00:00.405Z',
                    status: 'ok'
                }
            ]
        }),
        '$(gcmp-opencode) 64%'
    );
});

test('OpenCode usage URL honors override and trims trailing slashes', () => {
    assert.equal(
        resolveOpenCodeUsageUrl({ OPENCODE_USAGE_URL: ' https://proxy.example.test/custom/// ' }),
        'https://proxy.example.test/custom'
    );
    assert.equal(resolveOpenCodeUsageUrl({}), 'https://opencode.ai/zen/go/v1/usage');
});
