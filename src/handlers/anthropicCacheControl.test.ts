import assert from 'node:assert/strict';
import test from 'node:test';

import { addCacheControlBreakpoints, AnthropicCacheableMessage, AnthropicCacheableTool } from './anthropicCacheControl';

type TestSystem = { type: string; text: string; cache_control?: { type: string } | null };

function makeSystem(text: string): TestSystem {
    return { type: 'text', text };
}

function makeTool(name: string): AnthropicCacheableTool {
    return { name, input_schema: { type: 'object', properties: {}, required: [] } } as AnthropicCacheableTool;
}

function makeDeferredTool(name: string): AnthropicCacheableTool {
    // defer_loading 的延迟加载工具不进系统前缀，不可作为缓存断点
    return {
        name,
        defer_loading: true,
        input_schema: { type: 'object', properties: {}, required: [] }
    } as AnthropicCacheableTool;
}

function msg(role: string, ...texts: (string | { text: string; cached?: boolean })[]): AnthropicCacheableMessage {
    return {
        role,
        content: texts.map(t =>
            typeof t === 'string' ?
                { type: 'text', text: t }
            :   { type: 'text', text: t.text, ...(t.cached ? { cache_control: { type: 'ephemeral' } } : {}) }
        )
    } as AnthropicCacheableMessage;
}

function countCacheControl(
    tools: AnthropicCacheableTool[],
    system: { cache_control?: { type: string } | null } | undefined,
    messages: AnthropicCacheableMessage[]
): number {
    let count = tools.filter(t => t.cache_control).length + (system?.cache_control ? 1 : 0);
    for (const m of messages) {
        if (Array.isArray(m.content)) {
            count += (m.content as { cache_control?: unknown }[]).filter(b => b.cache_control).length;
        }
    }
    return count;
}

test('给最后一个工具和 system 打断点', () => {
    const tools = [makeTool('read_file'), makeTool('edit_file')];
    const system = makeSystem('You are helpful.');

    addCacheControlBreakpoints(tools, { messages: [], system });

    assert.equal(tools[0].cache_control, undefined);
    assert.deepEqual(tools[1].cache_control, { type: 'ephemeral' });
    assert.deepEqual(system.cache_control, { type: 'ephemeral' });
});

test('跳过 defer_loading 工具，断点打在前一个可缓存工具', () => {
    const tools = [makeTool('read_file'), makeDeferredTool('deferred_tool')];

    addCacheControlBreakpoints(tools, { messages: [], system: undefined });

    assert.deepEqual(tools[0].cache_control, { type: 'ephemeral' });
    assert.equal(tools[1].cache_control, undefined);
});

test('服务端工具（web_search，无 defer_loading）也可作为缓存断点', () => {
    // web_search_20250305 等服务端工具属于 tools 前缀一部分，可参与缓存
    const tools = [
        makeTool('read_file'),
        { name: 'web_search', type: 'web_search_20250305' } as AnthropicCacheableTool
    ];

    addCacheControlBreakpoints(tools, { messages: [], system: undefined });

    assert.equal(tools[0].cache_control, undefined);
    assert.deepEqual(tools[1].cache_control, { type: 'ephemeral' });
});

test('不驱逐消息级断点，只在有空位时补充', () => {
    const tools = [makeTool('read_file')];
    const system = makeSystem('sys');
    const messages = [
        msg('user', { text: 'a', cached: true }),
        msg('assistant', { text: 'b', cached: true }),
        msg('user', { text: 'c', cached: true })
    ];

    addCacheControlBreakpoints(tools, { messages, system });

    // 3 个消息级断点保留，1 个空位给工具，system 无空位
    assert.deepEqual(tools[0].cache_control, { type: 'ephemeral' });
    assert.equal(system.cache_control, undefined);
    assert.equal(countCacheControl(tools, system, messages), 4);
});

test('断点已满（≥4）时不再添加', () => {
    const tools = [makeTool('read_file')];
    const system = makeSystem('sys');
    const messages = [
        msg('user', { text: 'a', cached: true }),
        msg('assistant', { text: 'b', cached: true }),
        msg('user', { text: 'c', cached: true }),
        msg('assistant', { text: 'd', cached: true })
    ];

    addCacheControlBreakpoints(tools, { messages, system });

    assert.equal(tools[0].cache_control, undefined);
    assert.equal(system.cache_control, undefined);
    assert.equal(countCacheControl(tools, system, messages), 4);
});

test('空 system 文本不打断点', () => {
    const tools = [makeTool('read_file')];
    const system = makeSystem('  ');

    addCacheControlBreakpoints(tools, { messages: [], system });

    assert.equal(system.cache_control, undefined);
});

test('system 未提供时仍给工具打断点', () => {
    const tools = [makeTool('read_file')];

    addCacheControlBreakpoints(tools, { messages: [], system: undefined });

    assert.deepEqual(tools[0].cache_control, { type: 'ephemeral' });
});

test('无工具时仅给 system 打断点', () => {
    const system = makeSystem('sys');

    addCacheControlBreakpoints([], { messages: [], system });

    assert.deepEqual(system.cache_control, { type: 'ephemeral' });
});

test('thinking 块上的已有断点不计入（不支持缓存控制）', () => {
    const tools = [makeTool('read_file')];
    const messages = [
        {
            content: [
                { type: 'thinking', thinking: 't', signature: 's', cache_control: { type: 'ephemeral' } },
                { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }
            ]
        } as AnthropicCacheableMessage
    ];

    addCacheControlBreakpoints(tools, { messages, system: undefined });

    // thinking 块断点不计入 → 占用 1/4，工具仍可打断点
    assert.deepEqual(tools[0].cache_control, { type: 'ephemeral' });
});

// ---- 消息级断点（对齐 VS Code 1.129 规则） ----

function toolResultMsg(): AnthropicCacheableMessage {
    return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'r' }] }]
    };
}
function mixedToolResultAndUserTextMsg(): AnthropicCacheableMessage {
    return {
        role: 'user',
        content: [
            { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'r' }] },
            { type: 'text', text: 'current question' }
        ]
    };
}
function toolUseAssistant(): AnthropicCacheableMessage {
    return { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 't', input: {} }] };
}
function textAssistant(): AnthropicCacheableMessage {
    return { role: 'assistant', content: [{ type: 'text', text: 'reply' }] };
}
function userMsg(): AnthropicCacheableMessage {
    return { role: 'user', content: [{ type: 'text', text: 'q' }] };
}
function cachedOf(m: AnthropicCacheableMessage): unknown[] {
    return (m.content as { cache_control?: unknown }[]).filter(b => b.cache_control).map(b => b.cache_control);
}

test('消息级：agentic 一轮给最后一个 tool_result 打断点', () => {
    const messages = [userMsg(), toolUseAssistant(), toolResultMsg()];

    addCacheControlBreakpoints([], { messages, system: undefined });

    assert.equal(cachedOf(messages[2]).length, 1, '最后一个 tool_result 应被打断点');
});

test('消息级：无工具调用的 assistant 终止回复打断点', () => {
    const messages = [userMsg(), textAssistant(), userMsg()];

    addCacheControlBreakpoints([], { messages, system: undefined });

    // 当前 user（倒序第一个）+ 之上的无工具 assistant
    assert.equal(cachedOf(messages[2]).length, 1, '当前 user 应被打断点');
    assert.equal(cachedOf(messages[1]).length, 1, '无工具 assistant 应被打断点');
});

test('消息级：连续多个 tool_result 只给最后一个打', () => {
    const messages = [userMsg(), toolUseAssistant(), toolResultMsg(), toolResultMsg()];

    addCacheControlBreakpoints([], { messages, system: undefined });

    assert.equal(cachedOf(messages[3]).length, 1, '最后的 tool_result 打断点');
});

test('消息级：混合 tool_result + text 的当前 user 也视为边界', () => {
    const messages = [
        userMsg(),
        toolUseAssistant(),
        toolResultMsg(),
        toolUseAssistant(),
        mixedToolResultAndUserTextMsg()
    ];

    addCacheControlBreakpoints([], { messages, system: undefined });

    assert.equal(cachedOf(messages[4]).length, 1, '混合 user 应作为当前 user 被打断点');
    assert.equal(cachedOf(messages[2]).length, 0, '边界前的 tool_result 不应误当成当前轮次');
});

test('消息级：总断点数不超过 4', () => {
    const messages = [
        userMsg(),
        textAssistant(),
        userMsg(),
        toolUseAssistant(),
        toolResultMsg(),
        textAssistant(),
        userMsg()
    ];

    addCacheControlBreakpoints([], { messages, system: undefined });

    const total = messages.reduce((n, m) => n + cachedOf(m).length, 0);
    assert.ok(total <= 4, `总断点 ${total} 应 ≤ 4`);
});

test('消息级：已有断点的消息不重复打', () => {
    const tr = toolResultMsg();
    (tr.content as { cache_control?: unknown }[])[0].cache_control = { type: 'ephemeral' };
    const messages = [userMsg(), toolUseAssistant(), tr];

    addCacheControlBreakpoints([], { messages, system: undefined });

    assert.equal(cachedOf(messages[2]).length, 1, '已有断点不叠加');
});

test('消息级：剩余空位回填最早 user 前缀', () => {
    const messages = [userMsg(), textAssistant(), userMsg()];

    addCacheControlBreakpoints([], { messages, system: undefined });

    assert.equal(cachedOf(messages[0]).length, 1, '空位应回填最早 user 前缀');
    assert.equal(cachedOf(messages[2]).length, 1, '当前 user 仍应被打断点');
});
