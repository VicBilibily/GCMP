import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOpenCodeUsage, resolveOpenCodeUsageUrl } from './opencodeUsage';

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

test('OpenCode usage URL honors override and trims trailing slashes', () => {
    assert.equal(
        resolveOpenCodeUsageUrl({ OPENCODE_USAGE_URL: ' https://proxy.example.test/custom/// ' }),
        'https://proxy.example.test/custom'
    );
    assert.equal(resolveOpenCodeUsageUrl({}), 'https://opencode.ai/zen/go/v1/usage');
});
