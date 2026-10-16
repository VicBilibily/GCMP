import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

test('quota panel and status bar countdowns stay consistent across locales', async context => {
    const environment = { language: 'en' };
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { env: environment };
        }
        return originalRequire.call(this, id);
    };

    let formatters: typeof import('./format');
    try {
        formatters = await import('./format');
    } finally {
        NodeModule.prototype.require = originalRequire;
    }

    const now = Date.parse('2026-10-16T12:00:00.000Z');
    context.mock.method(Date, 'now', () => now);
    const resetAfter = (seconds: number): string => new Date(now + seconds * 1000).toISOString();

    for (const language of ['en', 'zh-cn']) {
        environment.language = language;
        const resetsSoon = language === 'zh-cn' ? '\u5373\u5c06\u91cd\u7f6e' : 'Resets soon';
        const cases = [
            { name: 'days with padded hours', resetAt: resetAfter(2 * 86400 + 3 * 3600), expected: '2d 03h' },
            { name: 'whole days', resetAt: resetAfter(2 * 86400), expected: '2d' },
            { name: 'hours with padded minutes', resetAt: resetAfter(3 * 3600 + 9 * 60), expected: '3h 09m' },
            { name: 'whole hours', resetAt: resetAfter(3 * 3600), expected: '3h' },
            { name: 'minutes', resetAt: resetAfter(23 * 60 + 45), expected: '23m' },
            { name: 'seconds', resetAt: resetAfter(45), expected: '45s' },
            { name: 'minute boundary', resetAt: resetAfter(60), expected: '1m' },
            { name: 'hour boundary', resetAt: resetAfter(3600), expected: '1h' },
            { name: 'day boundary', resetAt: resetAfter(86400), expected: '1d' },
            { name: 'reset boundary', resetAt: resetAfter(0), expected: resetsSoon },
            { name: 'expired reset', resetAt: resetAfter(-60), expected: resetsSoon },
            { name: 'invalid reset', resetAt: 'not-a-date', expected: resetsSoon }
        ];

        for (const testCase of cases) {
            await context.test(`${language}: ${testCase.name}`, () => {
                assert.equal(formatters.formatCompactCountdown(testCase.resetAt), testCase.expected);
                assert.equal(formatters.formatQuotaCountdown(testCase.resetAt), testCase.expected);
            });
        }
    }
});
