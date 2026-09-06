import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildCodexUserAgent,
    fillClaudeCodeRequestHeaders,
    fillCodexRequestHeaders,
    getCodexTuiUserAgent,
    getCodexTuiUserAgentFromHeader,
    getCodexUserAgent
} from './cliUserAgent';
import { setRemoteCliMetadata } from '../metadata/metadataResolver';
import builtinMetadata from '../metadata/gcmp-metadata.json';
import {
    canonicalizeUserAgentHeader,
    ensureUserAgentHeader,
    getUserAgentHeaderValue,
    withUserAgentHeader
} from './httpHeaders';

// 内置兜底版本断言统一引用共享元数据源文件，避免 update:metadata 升级后测试失效
const claudeCodeVersionEscaped = builtinMetadata.cli.claudeCode.version.replace(/\./g, '\\.');
const claudeCliUaPattern = new RegExp(`^claude-cli/${claudeCodeVersionEscaped} \\(external, cli\\)$`);

test('buildCodexUserAgent renders codex CLI style UA with explicit fields', () => {
    const ua = buildCodexUserAgent({
        originator: 'codex-tui',
        version: '0.153.0',
        osType: 'Windows',
        osVersion: '10.0.26200',
        architecture: 'x86_64',
        suffix: 'codex-tui; 0.153.0'
    });
    assert.equal(ua, 'codex-tui/0.153.0 (Windows 10.0.26200; x86_64) unknown (codex-tui; 0.153.0)');
});

test('getCodexTuiUserAgent appends originator/version suffix', () => {
    const ua = getCodexTuiUserAgent('0.153.0');
    assert.match(ua, /^codex-tui\/0\.153\.0 \([^)]+; [^)]+\) \S+ \(codex-tui; 0\.153\.0\)$/);
});

test('getCodexTuiUserAgent uses custom originator when provided', () => {
    const ua = getCodexTuiUserAgent('1.2.3', 'codex_vscode');
    assert.match(ua, /^codex_vscode\/1\.2\.3 \(/);
    assert.match(ua, /\(codex_vscode; 1\.2\.3\)$/);
});

test('suffix is omitted when absent or whitespace', () => {
    const withSuffix = buildCodexUserAgent({
        originator: 'codex-tui',
        version: '0.1.0',
        osType: 'Windows',
        osVersion: '10.0.0',
        architecture: 'x86_64',
        suffix: ' extra '
    });
    assert.equal(withSuffix, 'codex-tui/0.1.0 (Windows 10.0.0; x86_64) unknown (extra)');

    const noSuffix = buildCodexUserAgent({
        originator: 'codex-tui',
        version: '0.1.0',
        osType: 'Windows',
        osVersion: '10.0.0',
        architecture: 'x86_64'
    });
    assert.equal(noSuffix, 'codex-tui/0.1.0 (Windows 10.0.0; x86_64) unknown');
});

test('buildCodexUserAgent sanitizes invalid header characters', () => {
    const ua = buildCodexUserAgent({
        originator: 'codex-tui',
        version: '0.1.0',
        osType: 'Windows',
        osVersion: '10.0.0',
        architecture: 'x86_64',
        suffix: 'bad\rsuffix'
    });
    assert.equal(ua, 'codex-tui/0.1.0 (Windows 10.0.0; x86_64) unknown (bad_suffix)');
});

test('getCodexUserAgent auto-detects system fields and keeps codex UA shape', () => {
    const ua = getCodexUserAgent({ version: '0.153.0' });
    // {originator}/{version} ({os_type} {os_version}; {arch}) {terminal_token}
    assert.match(ua, /^codex-tui\/0\.153\.0 \([^)]+; [^)]+\) \S+$/);
});

test('buildCodexUserAgent applies field fallbacks', () => {
    const ua = buildCodexUserAgent({
        originator: '',
        version: '',
        osType: '',
        osVersion: '',
        architecture: '',
        suffix: '  '
    });
    assert.equal(ua, 'codex-tui/ ( ; unknown) unknown');
});

test('getCodexTuiUserAgentFromHeader reads originator and version', () => {
    const ua = getCodexTuiUserAgentFromHeader({ originator: 'codex_vscode', version: '1.2.3' });
    assert.match(ua, /^codex_vscode\/1\.2\.3 \(/);
    assert.match(ua, /\(codex_vscode; 1\.2\.3\)$/);
});

test('getCodexTuiUserAgentFromHeader falls back when header fields are absent', () => {
    const ua = getCodexTuiUserAgentFromHeader();
    assert.match(ua, /^codex-tui\/ \([^)]+; [^)]+\) \S+$/);
    assert.equal(getCodexTuiUserAgentFromHeader({ version: '1.2.3' }).startsWith('codex-tui/1.2.3'), true);
});

test('withUserAgentHeader drops other user-agent casings', () => {
    const headers = withUserAgentHeader({ 'user-agent': 'old', originator: 'codex-tui' }, 'codex-tui/1.0');
    assert.equal(headers['User-Agent'], 'codex-tui/1.0');
    assert.equal(headers['user-agent'], undefined);
    assert.equal(headers.originator, 'codex-tui');
});

test('canonicalizeUserAgentHeader keeps the last user-agent value', () => {
    const headers = {
        'User-Agent': 'GCMP-OpenAI/0.1',
        originator: 'codex-tui',
        'user-agent': 'codex-tui/0.153.0'
    };
    canonicalizeUserAgentHeader(headers);
    assert.equal(headers['User-Agent'], 'codex-tui/0.153.0');
    assert.equal(headers['user-agent'], undefined);
    assert.equal(headers.originator, 'codex-tui');
});

test('getUserAgentHeaderValue and canonicalizeUserAgentHeader handle missing headers', () => {
    assert.equal(getUserAgentHeaderValue(), undefined);
    const headers = { originator: 'codex-tui' };
    canonicalizeUserAgentHeader(headers);
    assert.deepEqual(headers, { originator: 'codex-tui' });
});

test('ensureUserAgentHeader keeps override user-agent and fills in when missing', () => {
    const overridden = ensureUserAgentHeader(
        { originator: 'codex-tui', 'user-agent': 'custom-ua/1.0' },
        'codex-tui/generated'
    );
    assert.equal(overridden['User-Agent'], 'custom-ua/1.0');
    assert.equal(overridden['user-agent'], undefined);
    assert.equal(overridden.originator, 'codex-tui');

    const generated = ensureUserAgentHeader({ originator: 'codex-tui' }, 'codex-tui/generated');
    assert.equal(generated['User-Agent'], 'codex-tui/generated');
    assert.equal(generated.originator, 'codex-tui');

    const blankOverride = ensureUserAgentHeader({ 'User-Agent': '  ' }, 'codex-tui/generated');
    assert.equal(blankOverride['User-Agent'], 'codex-tui/generated');

    const noHeaders = ensureUserAgentHeader(undefined, 'codex-tui/generated');
    assert.deepEqual(noHeaders, { 'User-Agent': 'codex-tui/generated' });
});

test('fillCodexRequestHeaders fills Codex headers for gpt models without user-agent', () => {
    const defaults = { version: '0.153.0', originator: 'codex-tui' };
    const filled = fillCodexRequestHeaders({ id: 'gpt-5.4', sdkMode: 'openai-responses' }, defaults);
    assert.equal(filled?.originator, 'codex-tui');
    assert.equal(filled?.version, '0.153.0');
    assert.match(filled?.['User-Agent'] ?? '', /^codex-tui\/0\.153\.0 /);

    const byModelField = fillCodexRequestHeaders({ id: 'my-proxy', model: 'gpt-4o', sdkMode: 'openai' }, defaults);
    assert.match(byModelField?.['User-Agent'] ?? '', /^codex-tui\/0\.153\.0 /);

    const explicit = fillCodexRequestHeaders({ id: 'gpt-5.4', customHeader: { 'user-agent': 'my-ua/1.0' } }, defaults);
    assert.equal(explicit?.['user-agent'], 'my-ua/1.0');
    assert.equal(explicit?.['User-Agent'], undefined);
    assert.equal(explicit?.originator, undefined);

    const blankExplicit = fillCodexRequestHeaders({ id: 'GPT-5.4', customHeader: { 'User-Agent': '  ' } }, defaults);
    assert.match(blankExplicit?.['User-Agent'] ?? '', /^codex-tui\/0\.153\.0 /);

    const preserved = { 'X-Test': 'value' };
    assert.equal(fillCodexRequestHeaders({ id: 'claude-sonnet', customHeader: preserved }), preserved);

    const anthropicHeaders = { 'X-Test': 'value' };
    assert.equal(
        fillCodexRequestHeaders({ id: 'gpt-fake', sdkMode: 'anthropic', customHeader: anthropicHeaders }),
        anthropicHeaders
    );

    const generatedWithoutDefaults = fillCodexRequestHeaders({ id: 'GPT-5.4' });
    assert.match(generatedWithoutDefaults?.['User-Agent'] ?? '', /^codex-tui\/ /);

    assert.equal(fillCodexRequestHeaders({ id: 'claude-sonnet', sdkMode: 'openai' }, defaults), undefined);
    assert.equal(fillCodexRequestHeaders({ id: 'gpt-fake', sdkMode: 'anthropic' }, defaults), undefined);
});

test('fillClaudeCodeRequestHeaders fills Claude Code UA for claude models without user-agent', () => {
    const filled = fillClaudeCodeRequestHeaders({ id: 'claude-sonnet-4-5', sdkMode: 'anthropic' });
    assert.match(filled?.['User-Agent'] ?? '', claudeCliUaPattern);
    assert.equal(filled?.['X-Stainless-Package-Version'], undefined);

    assert.equal(fillClaudeCodeRequestHeaders({ id: 'proxy-alias', sdkMode: 'anthropic' }), undefined);

    const explicit = fillClaudeCodeRequestHeaders({
        id: 'claude-sonnet-4-5',
        sdkMode: 'anthropic',
        customHeader: { 'user-agent': 'my-ua/1.0' }
    });
    assert.equal(explicit?.['User-Agent'], 'my-ua/1.0');
    assert.equal(explicit?.['user-agent'], undefined);

    const blankExplicit = fillClaudeCodeRequestHeaders({
        id: 'claude-sonnet-4-5',
        sdkMode: 'anthropic',
        customHeader: { 'User-Agent': '  ' }
    });
    assert.match(blankExplicit?.['User-Agent'] ?? '', claudeCliUaPattern);

    const preservedHeader = fillClaudeCodeRequestHeaders({
        id: 'claude-sonnet-4-5',
        sdkMode: 'anthropic',
        customHeader: { 'X-Stainless-Package-Version': '9.9.9' }
    });
    assert.match(preservedHeader?.['User-Agent'] ?? '', new RegExp(`^claude-cli/${claudeCodeVersionEscaped}`));
    assert.equal(preservedHeader?.['X-Stainless-Package-Version'], '9.9.9');

    const gptModel = { 'X-Test': 'value' };
    assert.equal(fillClaudeCodeRequestHeaders({ id: 'gpt-5.4', customHeader: gptModel }), gptModel);
    assert.equal(fillClaudeCodeRequestHeaders({ id: 'deepseek', sdkMode: 'openai' }), undefined);
    assert.equal(fillClaudeCodeRequestHeaders({ id: 'claude-sonnet-4-5', sdkMode: 'openai' }), undefined);
    const nonClaudeAnthropic = { 'X-Test': 'value' };
    assert.equal(
        fillClaudeCodeRequestHeaders({ id: 'gpt-fake', sdkMode: 'anthropic', customHeader: nonClaudeAnthropic }),
        nonClaudeAnthropic
    );
});

test('fillClaudeCodeRequestHeaders follows remote metadata version and restores fallback', () => {
    setRemoteCliMetadata({ claudeCodeVersion: '9.9.9' });
    try {
        const filled = fillClaudeCodeRequestHeaders({ id: 'claude-sonnet-4-5', sdkMode: 'anthropic' });
        assert.match(filled?.['User-Agent'] ?? '', /^claude-cli\/9\.9\.9 \(external, cli\)$/);
    } finally {
        setRemoteCliMetadata(undefined);
    }
    const restored = fillClaudeCodeRequestHeaders({ id: 'claude-sonnet-4-5', sdkMode: 'anthropic' });
    assert.match(restored?.['User-Agent'] ?? '', claudeCliUaPattern);
});
