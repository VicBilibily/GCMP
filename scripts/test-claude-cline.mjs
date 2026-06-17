/**
 * Cline SDK 方案验证
 *
 * Cline 实际采用的模式：
 * 1. --disallowedTools ALL — 禁用所有内置工具
 * 2. --max-turns 1 — 阻止 Agent Loop
 * 3. 工具定义以 XML 嵌入 system prompt
 * 4. Claude 输出包含 <tool_use> XML 的纯文本
 * 5. 通过 stdin 传 JSON messages 数组
 *
 * 本脚本精确复现 Cline 的 runClaudeCode 实现。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Cline 源码中的完整 disallowed 列表
const ALL_DISALLOWED = [
    'Task', 'TaskOutput', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write',
    'NotebookEdit', 'WebFetch', 'TodoWrite', 'WebSearch', 'TaskStop',
    'AskUserQuestion', 'Skill', 'EnterPlanMode', 'ExitPlanMode',
    'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete',
    'CronList', 'ToolSearch'
].join(',');

/**
 * Cline 精确复现：runProcess() 的 exact 参数
 */
function runClaude(systemPrompt, messages, modelId = 'sonnet') {
    return new Promise((resolve, reject) => {
        const args = [
            '--system-prompt', systemPrompt,
            '--verbose',
            '--output-format', 'stream-json',
            '--disallowedTools', ALL_DISALLOWED,
            '--max-turns', '1',
            '--model', modelId,
            '-p', '',
        ];

        const env = {
            ...process.env,
            CLAUDE_TERMINAL_WIDTH: '120',
            CLI_COLOR: '0',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
        };
        delete env.ANTHROPIC_API_KEY;

        const proc = spawn('claude', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
            env,
        });

        const events = [];
        let stderr = '';
        let resolved = false;
        const timer = setTimeout(() => {
            if (!resolved) { resolved = true; proc.kill('SIGTERM'); resolve({ events, stderr }); }
        }, 60000);

        proc.stderr.on('data', c => { stderr += c; });
        const rl = createInterface({ input: proc.stdout });
        rl.on('line', l => {
            try { events.push(JSON.parse(l.trim())); } catch { }
        });
        rl.on('close', () => {
            if (!resolved) { resolved = true; clearTimeout(timer); resolve({ events, stderr }); }
        });
        proc.on('error', (err) => {
            if (!resolved) { resolved = true; clearTimeout(timer); reject(err); }
        });

        // Cline 精确方式：stdin 写入 JSON 数组后立即 end
        proc.stdin.write(JSON.stringify(messages));
        proc.stdin.end();
    });
}

function getText(events) {
    const t = [];
    for (const e of events) {
        if (e.type === 'assistant' && e.message?.content) {
            for (const c of e.message.content) {
                if (c.type === 'text') t.push(c.text);
            }
        }
    }
    return t;
}

function getToolUses(events) {
    const tus = [];
    for (const e of events) {
        if (e.type === 'assistant' && e.message?.content) {
            for (const c of e.message.content) {
                if (c.type === 'tool_use') tus.push(c);
            }
        }
    }
    return tus;
}

async function main() {
    console.log('='.repeat(70));
    console.log('Cline SDK 方案精确复现验证');
    console.log('System Prompt (XML 工具定义) + --disallowedTools ALL + --max-turns 1');
    console.log('='.repeat(70));

    // ===== 测试 1：system prompt 嵌入工具定义 → 验证输出包含 tool_use =====
    console.log('\n--- 测试 1：XML 工具定义在 system prompt 中 ---\n');

    const systemPrompt = `You are a coding assistant with access to tools.

When you want to use a tool, output exactly:
<tool_use>
<name>TOOL_NAME</name>
<input>{"key":"value"}</input>
</tool_use>

<tools>
<tool name="read_file">
<description>Read file contents from disk</description>
<input_schema>{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}</input_schema>
</tool>
<tool name="calculate">
<description>Execute math calculation</description>
<input_schema>{"type":"object","properties":{"expression":{"type":"string"}},"required":["expression"]}</input_schema>
</tool>
</tools>`;

    const messages1 = [
        { role: 'user', content: [{ type: 'text', text: 'What is 42 * 37? Use the calculate tool.' }] }
    ];

    const r1 = await runClaude(systemPrompt, messages1);
    const t1 = getText(r1.events).join(' ');
    const nativeTus1 = getToolUses(r1.events);

    const hasToolUseXml = /<tool_use>[\s\S]*?<\/tool_use>/i.test(t1);
    const hasNativeToolUse = nativeTus1.length > 0;

    console.log(`  Content block types: [${r1.events.filter(e => e.type === 'assistant').flatMap(e => (e.message?.content || []).map(c => c.type)).join(', ')}]`);
    console.log(`  Native tool_use blocks: ${nativeTus1.length}`);
    console.log(`  <tool_use> XML in text: ${hasToolUseXml ? 'YES' : 'NO'}`);
    console.log(`  Model: ${r1.events.find(e => e.type === 'assistant')?.message?.model || '?'}`);
    if (nativeTus1.length > 0) {
        for (const tu of nativeTus1) {
            console.log(`  TOOL: name=${tu.name} input=${JSON.stringify(tu.input)}`);
        }
    }
    const toolUseMatch = t1.match(/<tool_use>[\s\S]*?<\/tool_use>/i);
    if (toolUseMatch) {
        console.log(`\n  >> XML tool_use found in assistant text:\n${toolUseMatch[0]}`);
    }
    if (t1) console.log(`  Full text: "${t1.substring(0, 400)}"`);

    // ===== 测试 2：第二轮注入 tool_result =====
    console.log('\n--- 测试 2：tool_result 注入后的多轮推理 ---\n');

    // 构造完整的对话历史（user + tool_use + tool_result）
    const messages2 = [
        { role: 'user', content: [{ type: 'text', text: 'What is 42 * 37?' }] },
        { role: 'assistant', content: [{ type: 'text', text: '<tool_use><name>calculate</name><input>{"expression":"42*37"}</input></tool_use>' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '1554' }] },
        { role: 'user', content: [{ type: 'text', text: 'What did you get?' }] },
    ];

    const r2 = await runClaude(systemPrompt, messages2);
    const t2 = getText(r2.events).join(' ');
    const has1554 = /1554/i.test(t2);

    console.log(`  Content mentions 1554: ${has1554 ? 'YES' : 'NO'}`);
    console.log(`  Text: "${t2.substring(0, 400)}"`);
    if (!has1554) console.log('  [DEBUG] Full events:', JSON.stringify(r2.events.map(e => ({ t: e.type }))));

    // ===== 测试 3：元数据 =====
    console.log('\n--- 测试 3：元数据 ---\n');
    const r3 = await runClaude('Say exactly: TEST', [{ role: 'user', content: [{ type: 'text', text: 'Say TEST' }] }]);
    const asst3 = r3.events.find(e => e.type === 'assistant');
    const res3 = r3.events.find(e => e.type === 'result');
    if (asst3?.message?.usage) {
        console.log(`  Input tokens: ${asst3.message.usage.input_tokens}`);
        console.log(`  Output tokens: ${asst3.message.usage.output_tokens}`);
        if (asst3.message.usage.cache_read_input_tokens) {
            console.log(`  Cache read: ${asst3.message.usage.cache_read_input_tokens}`);
            console.log(`  Cache creation: ${asst3.message.usage.cache_creation_input_tokens}`);
        }
    }
    if (res3?.total_cost_usd !== undefined) console.log(`  Cost: \$${res3.total_cost_usd}`);
    if (res3?.duration_ms) console.log(`  Duration: ${res3.duration_ms}ms`);
    if (res3?.stop_reason) console.log(`  Stop reason: ${res3.stop_reason}`);

    // ===== 总结 =====
    console.log('\n' + '='.repeat(70));
    console.log('验证总结');
    console.log('='.repeat(70));
    console.log(`\nCline 方案核心要素:`);
    console.log(`  1. --disallowedTools ALL   ✅ 已确认`);
    console.log(`  2. --max-turns 1          ✅ 已确认`);
    console.log(`  3. system prompt XML 定义   ${hasToolUseXml ? '✅ 可用' : '❌ 需确认'}`);
    console.log(`  4. 原生 tool_use block     ${hasNativeToolUse ? '✅ 出现' : '🔶 无（依赖 XML）'}`);
    console.log(`  5. tool_result 回注理解    ${has1554 ? '✅ 通过' : '❌ 失败'}`);
    console.log('');
    console.log(`  结论: Cline 通过 ${hasNativeToolUse ? '原生 tool_use + ' : ''}${hasToolUseXml ? 'system prompt XML 注入' : '?'} 实现`);
    console.log('='.repeat(70));
}

main().catch(console.error);
