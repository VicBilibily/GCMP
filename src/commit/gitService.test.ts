import assert from 'node:assert/strict';
import test from 'node:test';

import { filterDiffSnippets, isSensitiveFile, normalizeDiffExcerpt } from './diffFilter';
import type { FileDiffSnippet } from './diffSnippetService';

test('gitService filters built-in sensitive file patterns', () => {
    assert.equal(isSensitiveFile('src/launch.json', []), true);
    assert.equal(isSensitiveFile('.aws/credentials', []), true);
    assert.equal(isSensitiveFile('config/.env.production', []), true);
    assert.equal(isSensitiveFile('keys/id_rsa_backup', []), true);
    assert.equal(isSensitiveFile('src/features/app.ts', []), false);
});

test('gitService filters custom sensitive glob patterns', () => {
    const sensitiveFiles = ['secrets/**', '*.token', '**/private/*.key'];

    assert.equal(isSensitiveFile('secrets/payment/config.json', sensitiveFiles), true);
    assert.equal(isSensitiveFile('auth/service.token', sensitiveFiles), true);
    assert.equal(isSensitiveFile('src/private/client.key', sensitiveFiles), true);
    assert.equal(isSensitiveFile('src/private/client.txt', sensitiveFiles), false);
});

test('gitService omits lockfile and snapshot diff bodies', () => {
    const excerpt = [
        'diff --git a/package-lock.json b/package-lock.json',
        'index 123..456 100644',
        '--- a/package-lock.json',
        '+++ b/package-lock.json',
        '@@ -1,3 +1,3 @@',
        '-"left-pad": "1.0.0"',
        '+"left-pad": "1.0.1"'
    ].join('\n');

    const normalized = normalizeDiffExcerpt('package-lock.json', excerpt, 12000);

    assert.match(normalized, /lockfile\/snapshot diff omitted/);
    assert.doesNotMatch(normalized, /left-pad/);
});

test('gitService unifiedDiffToSection omits sensitive files but keeps safe files', () => {
    const snippets: FileDiffSnippet[] = [
        {
            filePath: '.env.local',
            excerpt: ['diff --git a/.env.local b/.env.local', '@@ -1 +1 @@', '-SECRET=old', '+SECRET=new'].join('\n'),
            charCount: 80
        },
        {
            filePath: 'src/app.ts',
            excerpt: ['diff --git a/src/app.ts b/src/app.ts', '@@ -1 +1 @@', '-old()', '+new()'].join('\n'),
            charCount: 64
        }
    ];

    const result = filterDiffSnippets('C:/repo', snippets, 12000, []);

    assert.equal(result.length, 1);
    assert.match(result[0].fsPath, /src[\\/]app\.ts$/);
    assert.match(result[0].diff, /new\(\)/);
    assert.doesNotMatch(result[0].diff, /SECRET=/);
});
