import assert from 'node:assert/strict';
import test from 'node:test';

import {
    mergeTitleEntry,
    SessionTitleService,
    toDisplayTitle,
    type ChatMessageLike,
    type SessionTitleEntry
} from './sessionTitleService';

const ROLE_USER = 1;
const ROLE_ASSISTANT = 2;

function userMessage(text: string): ChatMessageLike {
    return { role: ROLE_USER, content: [{ value: text }] };
}

function assistantMessage(text: string): ChatMessageLike {
    return { role: ROLE_ASSISTANT, content: [{ value: text }] };
}

/** 模拟 Copilot 封装后的用户消息（多 part 文本拼接） */
function wrappedUserMessage(prefix: string, userRequest: string): ChatMessageLike {
    return {
        role: ROLE_USER,
        content: [
            { value: prefix },
            {
                value: `<context>\nThe current date is 2026-07-28.\n</context>\n<userRequest>\n${userRequest}\n</userRequest>\n`
            }
        ]
    };
}

test('extractUserRequestText extracts raw input from wrapped message', () => {
    const messages = [wrappedUserMessage('<environment_info>\nOS: Windows\n</environment_info>', '搜索vue3.6')];
    assert.equal(SessionTitleService.extractUserRequestText(messages), '搜索vue3.6');
});

test('extractUserRequestText picks the first userRequest among multiple messages', () => {
    const messages = [
        wrappedUserMessage('', '第一个话题'),
        assistantMessage('回复'),
        wrappedUserMessage('', '第二个话题')
    ];
    assert.equal(SessionTitleService.extractUserRequestText(messages), '第一个话题');
});

test('extractUserRequestText returns undefined when no userRequest tag exists', () => {
    const messages = [
        userMessage('Please write a brief title for the following request:\n\n搜索vue3.6'),
        { role: ROLE_USER, content: [{ data: new Uint8Array([1, 2]) }] }
    ];
    assert.equal(SessionTitleService.extractUserRequestText(messages), undefined);
});

test('extractTitleGenerationRequestText extracts raw request from title prompt', () => {
    const messages = [userMessage('Please write a brief title for the following request:\n\n搜索vue3.6')];
    assert.equal(SessionTitleService.extractTitleGenerationRequestText(messages), '搜索vue3.6');
});

test('extractTitleGenerationRequestText returns undefined for unrelated prompts', () => {
    assert.equal(SessionTitleService.extractTitleGenerationRequestText([userMessage('普通问题')]), undefined);
});

test('toDisplayTitle collapses whitespace, strips quotes and truncates', () => {
    assert.equal(toDisplayTitle('  搜索\n vue3.6  '), '搜索 vue3.6');
    assert.equal(toDisplayTitle('"Vue 3.6 搜索"。'), 'Vue 3.6 搜索');
    const long = 'a'.repeat(100);
    const truncated = toDisplayTitle(long);
    assert.equal(truncated.length, 60);
    assert.ok(truncated.endsWith('…'));
});

test('registerSession does not expose a display title until generated title arrives', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-1', '搜索vue3.6');
    // raw 条目仅记录 matchKey 供回填匹配，不以原始输入截断作为展示标题
    assert.equal(service.getTitle('sess-1'), undefined);
});

test('registerSession ignores empty input', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-1', '   ');
    assert.equal(service.getTitle('sess-1'), undefined);
});

test('resolveGeneratedTitle upgrades matching session to generated title', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-1', '搜索vue3.6');
    const matched = service.resolveGeneratedTitle('搜索vue3.6', 'Vue 3.6 搜索');
    assert.equal(matched, true);
    assert.equal(service.getTitle('sess-1'), 'Vue 3.6 搜索');
});

test('resolveGeneratedTitle matches after whitespace normalization', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-1', '搜索\n  vue3.6');
    assert.equal(service.resolveGeneratedTitle('搜索 vue3.6', 'Vue 3.6 搜索'), true);
    assert.equal(service.getTitle('sess-1'), 'Vue 3.6 搜索');
});

test('resolveGeneratedTitle stashes pending title when session not yet registered', () => {
    const service = new SessionTitleService();
    assert.equal(service.resolveGeneratedTitle('搜索vue3.6', 'Vue 3.6 搜索'), false);
    // 会话随后注册时直接采用暂存的生成标题
    service.registerSession('sess-1', '搜索vue3.6');
    assert.equal(service.getTitle('sess-1'), 'Vue 3.6 搜索');
});

test('registerSession does not downgrade an existing generated title', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-1', '搜索vue3.6');
    service.resolveGeneratedTitle('搜索vue3.6', 'Vue 3.6 搜索');
    service.registerSession('sess-1', '另一个输入');
    assert.equal(service.getTitle('sess-1'), 'Vue 3.6 搜索');
});

test('resolveGeneratedTitle upgrades only the untitled session when matchKey collides', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-a', '审查此脚本');
    service.resolveGeneratedTitle('审查此脚本', '审查脚本');
    assert.equal(service.getTitle('sess-a'), '审查脚本');
    // 同文新会话：仅升级新会话，已有标题的 sess-a 不被覆盖
    service.registerSession('sess-b', '审查此脚本');
    assert.equal(service.resolveGeneratedTitle('审查此脚本', '脚本审查'), true);
    assert.equal(service.getTitle('sess-b'), '脚本审查');
    assert.equal(service.getTitle('sess-a'), '审查脚本');
});

test('resolveGeneratedTitle stashes title instead of overwriting when all same-key sessions are titled', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-a', '审查此脚本');
    service.resolveGeneratedTitle('审查此脚本', '审查脚本');
    // 同键会话均已有标题：不盲覆盖（可能是同文新会话尚未注册），暂存等待
    assert.equal(service.resolveGeneratedTitle('审查此脚本', '脚本审查'), false);
    assert.equal(service.getTitle('sess-a'), '审查脚本');
    // 随后注册的同文新会话采用暂存标题
    service.registerSession('sess-b', '审查此脚本');
    assert.equal(service.getTitle('sess-b'), '脚本审查');
    assert.equal(service.getTitle('sess-a'), '审查脚本');
});

test('resolveGeneratedTitle assigns duplicate-input titles one per session in recency order', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-1', '重复输入');
    service.registerSession('sess-2', '重复输入');
    // 两次同文标题响应各自归属一个无标题会话，互不覆盖
    assert.equal(service.resolveGeneratedTitle('重复输入', '标题一'), true);
    assert.equal(service.resolveGeneratedTitle('重复输入', '标题二'), true);
    const titles = [service.getTitle('sess-1'), service.getTitle('sess-2')].sort();
    assert.deepEqual(titles, ['标题一', '标题二']);
});

test('late generated title can still resolve after the formal request already completed', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-1', '晚到标题');
    service.markSessionCompleted('sess-1');
    assert.equal(service.resolveGeneratedTitle('晚到标题', '晚到标题结果'), true);
    assert.equal(service.getTitle('sess-1'), '晚到标题结果');
});

test('resolveGeneratedTitleDetails returns matched sessionId and remembered requestId', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-1', '晚到标题');
    service.rememberRequest('sess-1', 'req-1');

    const resolved = service.resolveGeneratedTitleDetails('晚到标题', '晚到标题结果');
    assert.deepEqual(resolved, {
        sessionId: 'sess-1',
        requestId: 'req-1',
        title: '晚到标题结果'
    });
});

test('registerSession returns pending title request info when title arrives before main session', () => {
    const service = new SessionTitleService();

    assert.equal(service.resolveGeneratedTitle('搜索vue3.6', 'Vue 3.6 搜索', 'title-req-1'), false);

    assert.deepEqual(service.registerSession('sess-1', '搜索vue3.6'), {
        title: 'Vue 3.6 搜索',
        titleRequestId: 'title-req-1'
    });
    assert.equal(service.getTitle('sess-1'), 'Vue 3.6 搜索');
});

test('active untitled session wins over completed untitled session for the same matchKey', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-old', '同文请求');
    service.markSessionCompleted('sess-old');
    service.registerSession('sess-live', '同文请求');

    assert.equal(service.resolveGeneratedTitle('同文请求', '当前会话标题'), true);
    assert.equal(service.getTitle('sess-live'), '当前会话标题');
    assert.equal(service.getTitle('sess-old'), undefined);
});

test('rememberResolvedTitle upgrades raw entry while preserving matchKey for later enrichment', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-1', '跨天会话');
    service.rememberResolvedTitle('sess-1', '历史标题', 123);

    assert.equal(service.getTitle('sess-1'), '历史标题');
    // 旧标题恢复后，后续同 session 再注册不应丢失标题
    service.registerSession('sess-1', '跨天会话');
    assert.equal(service.getTitle('sess-1'), '历史标题');
});

test('rememberResolvedTitle seeds generated title before resumed session registers again', () => {
    const service = new SessionTitleService();
    service.rememberResolvedTitle('sess-1', '前一天标题', 123);

    assert.equal(service.getTitle('sess-1'), '前一天标题');

    service.registerSession('sess-1', '第二天继续追问');
    assert.equal(service.getTitle('sess-1'), '前一天标题');
});

test('mergeTitleEntry prefers generated over raw, then newer updatedAt', () => {
    const raw: SessionTitleEntry = { title: '原始', matchKey: 'k', source: 'raw', updatedAt: 200 };
    const generated: SessionTitleEntry = { title: '生成', source: 'generated', updatedAt: 100 };
    assert.equal(mergeTitleEntry(raw, generated).title, '生成');
    assert.equal(mergeTitleEntry(generated, raw).title, '生成');
    assert.equal(mergeTitleEntry(raw, generated).matchKey, 'k');

    const older: SessionTitleEntry = { title: '旧', matchKey: 'k', source: 'raw', updatedAt: 100 };
    const newer: SessionTitleEntry = { title: '新', matchKey: 'k', source: 'raw', updatedAt: 200 };
    assert.equal(mergeTitleEntry(older, newer).title, '新');
});

test('matchKey is not truncated for long inputs and matches exactly', () => {
    const service = new SessionTitleService();
    const longText = '分析代码 '.repeat(200); // 远超旧 500 字符上限
    service.registerSession('sess-1', longText);
    assert.equal(service.resolveGeneratedTitle(longText, '长输入标题'), true);
    assert.equal(service.getTitle('sess-1'), '长输入标题');
});

test('prefix fallback matches when Copilot side text is truncated shorter', () => {
    const service = new SessionTitleService();
    const fullText = '请帮我分析这个非常复杂的性能问题，涉及数据库查询优化和缓存策略调整';
    const truncated = fullText.slice(0, 30); // Copilot 侧被裁剪变短
    service.registerSession('sess-1', fullText);
    assert.equal(service.resolveGeneratedTitle(truncated, '性能问题分析'), true);
    assert.equal(service.getTitle('sess-1'), '性能问题分析');
});

test('prefix fallback requires minimum length to avoid unreliable short matches', () => {
    const service = new SessionTitleService();
    service.registerSession('sess-1', '帮我看看这段代码有什么问题，是否需要重构');
    // 短于 20 字符的前缀不允许兜底匹配
    assert.equal(service.resolveGeneratedTitle('帮我看看这段代码', '代码审查'), false);
    assert.notEqual(service.getTitle('sess-1'), '代码审查');
});

test('prefix fallback only upgrades the most specific session to avoid polluting same-prefix sessions', () => {
    const service = new SessionTitleService();
    const sharedPrefix = '请帮我分析一下这个项目的代码结构和实现细节，';
    service.registerSession('sess-short', sharedPrefix + '特别是鉴权模块');
    service.registerSession('sess-long', sharedPrefix + '特别是鉴权模块的 token 刷新逻辑与并发安全问题');
    // Copilot 截断版只能匹配到较长会话（区分度最高者）
    const truncated = (sharedPrefix + '特别是鉴权模块的 token').slice(0, 40);
    assert.equal(service.resolveGeneratedTitle(truncated, '鉴权模块分析'), true);
    assert.equal(service.getTitle('sess-long'), '鉴权模块分析');
    // 较短会话的 matchKey 与截断版不互为前缀，不受影响
    assert.notEqual(service.getTitle('sess-short'), '鉴权模块分析');
});
