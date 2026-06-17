/**
 * Claude Code CLI 原生事件流验证脚本
 *
 * 基于 Cline 方案：--disallowedTools + --max-turns 1
 *
 * 验证步骤：
 * 1. 基础通信 + --disallowedTools 效果验证
 * 2. 原生 tool_use content block 出现
 * 3. tool_result 回注 + 多轮循环
 * 4. 并行多工具调用行为
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const CLAUDE_CMD = 'claude';
const TIMEOUT = 120_000;

// 完整的 disallowed 列表（包含所有内置工具 + ScheduleWakeup）
const ALL_DISALLOWED = [
    'Task', 'TaskOutput', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write',
    'NotebookEdit', 'WebFetch', 'TodoWrite', 'WebSearch', 'TaskStop',
    'AskUserQuestion', 'Skill', 'EnterPlanMode', 'ExitPlanMode',
    'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete',
    'CronList', 'ToolSearch', 'ScheduleWakeup'
].join(',');

// 仅禁用关键工具但不完全禁用，用于验证原生 tool_use
const PARTIAL_DISALLOWED = [
    'Task', 'TaskOutput', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write',
    'NotebookEdit', 'WebFetch', 'TodoWrite', 'WebSearch', 'TaskStop',
    'AskUserQuestion', 'Skill', 'EnterPlanMode', 'ExitPlanMode',
    'EnterWorktree', 'ExitWorktree'
].join(',');

const PASS = '✅';
const FAIL = '❌';
const results = [];
function report(name, passed, detail = '') {
    const icon = passed ? PASS : FAIL;
    console.log(`  ${icon} ${name}${detail ? ': ' + detail : ''}`);
    results.push({ name, passed, detail });
}

/**
 * 运行一次 Claude CLI，通过 stdin 传入 messages
 * 参数与 Cline 保持一致
 */
function runWithMessages(messages, modelId = 'sonnet', extraArgs = [], useFullDisallowed = true) {
    return new Promise((resolve) => {
        const disallowed = useFullDisallowed ? ALL_DISALLOWED : PARTIAL_DISALLOWED;
        const args = [
            '-p', '',
            '--output-format', 'stream-json',
            '--verbose',
            '--disallowedTools', disallowed,
            '--max-turns', '1',
            '--model', modelId,
            '--no-session-persistence',
            ...extraArgs
        ];

        const proc = spawn(CLAUDE_CMD, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
            env: {
                ...process.env,
                CLAUDE_TERMINAL_WIDTH: '120',
                CLI_COLOR: '0',
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
            }
        });

        // 删除 ANTHROPIC_API_KEY 让 CLI 使用本地凭证
        delete proc.env?.ANTHROPIC_API_KEY;

        const allEvents = [];
        let buf = '';
        let resolved = false;

        const tryResolve = (val) => {
            if (!resolved) { resolved = true; resolve(val); }
        };

        const timer = setTimeout(() => {
            proc.kill('SIGTERM');
            tryResolve({ events: allEvents, stderr: '', timeout: true });
        }, TIMEOUT);

        // 逐行解析 readline
        const rl = createInterface({ input: proc.stdout });
        rl.on('line', (line) => {
            const t = line.trim();
            if (!t) return;
            try {
                allEvents.push(JSON.parse(t));
            } catch { }
        });

        rl.on('close', () => {
            clearTimeout(timer);
            tryResolve({ events: allEvents, stderr: '', timeout: false });
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            tryResolve({ events: allEvents, stderr: err.message, timeout: false });
        });

        proc.on('exit', (code) => {
            if (!resolved) {
                clearTimeout(timer);
                tryResolve({ events: allEvents, stderr: `exit=${code}`, timeout: false });
            }
        });

        // Cline 方式：写入完整的 JSON messages 数组
        const anthropicMessages = messages.map(m => m.message);
        proc.stdin.write(JSON.stringify(anthropicMessages));
        proc.stdin.end();
    });
}

/** 抽取所有 content text */
function extractText(events) {
    const texts = [];
    for (const evt of events) {
        if (evt.type === 'assistant' && evt.message?.content) {
            for (const c of evt.message.content) {
                if (c.type === 'text') texts.push(c.text);
            }
        }
        if (evt.type === 'result' && evt.result) {
            texts.push(evt.result);
        }
    }
    return texts;
}

/** 查找所有 tool_use content block */
function findToolUses(events) {
    const tools = [];
    for (const evt of events) {
        if (evt.type === 'assistant' && evt.message?.content) {
            for (const c of evt.message.content) {
                if (c.type === 'tool_use') {
                    tools.push({ name: c.name, input: c.input, id: c.id });
                }
            }
        }
    }
    return tools;
}

/** 查找 assistant 事件中的 content block 类型 */
function findContentBlockTypes(events) {
    const types = new Set();
    for (const evt of events) {
        if (evt.type === 'assistant' && evt.message?.content) {
            for (const c of evt.message.content) types.add(c.type);
        }
    }
    return [...types];
}

// ============================================================

async function main() {
    console.log('='.repeat(70));
    console.log('Claude Code CLI 原生事件流验证');
    console.log('方案：--disallowedTools + --max-turns 1（Cline 方案）');
    console.log('='.repeat(70));

    // ======== 阶段 1：基础通信 ========
    console.log('\n' + '-'.repeat(70));
    console.log('阶段 1：基础通信 — 验证 --disallowedTools 效果');
    console.log('-'.repeat(70) + '\n');

    const r1 = await runWithMessages([
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Say exactly: HELLO_WORLD' }] } }
    ]);

    const hasEvents = r1.events.length > 0;
    const hasResult = r1.events.some(e => e.type === 'result');
    const contentTypes = findContentBlockTypes(r1.events);

    report('收到 NDJSON 事件', hasEvents, `${r1.events.length} 个`);
    report('包含 result 事件', hasResult);
    report(`content block 类型: [${contentTypes.join(', ')}]`, contentTypes.includes('text'));

    const texts = extractText(r1.events);
    console.log(`  输出: "${texts.join(' ').substring(0, 100)}"`);

    if (!hasResult) { console.log('\n基础通信失败，终止'); return; }

    // ======== 阶段 2：原生 tool_use ========
    console.log('\n' + '-'.repeat(70));
    console.log('阶段 2：验证原生 tool_use content block');
    console.log('-'.repeat(70) + '\n');

    const r2 = await runWithMessages([
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Read the file package.json and tell me its "name" field. Read the actual file content.' }] } }
    ]);

    const toolUses = findToolUses(r2.events);
    const contentTypes2 = findContentBlockTypes(r2.events);

    report(`content block 类型: [${contentTypes2.join(', ')}]`, contentTypes2.includes('tool_use'),
        contentTypes2.includes('tool_use') ? '✅ 原生 tool_use 出现！' : '未出现 tool_use');
    report(`tool_use 数量`, toolUses.length > 0, `${toolUses.length} 个`);
    report(`result 事件存在`, r2.events.some(e => e.type === 'result'));

    if (toolUses.length > 0) {
        // 打印每个 tool_use 的完整结构
        for (let i = 0; i < toolUses.length; i++) {
            const tu = toolUses[i];
            console.log(`\n  tool_use #${i + 1}:`);
            console.log(`    name: ${tu.name}`);
            console.log(`    input: ${JSON.stringify(tu.input, null, 4)}`);
            console.log(`    id: ${tu.id}`);
        }

        // 打印包含 tool_use 的 assistant 事件的完整结构
        const tuEvent = r2.events.find(e =>
            e.type === 'assistant' && e.message?.content?.some?.(c => c.type === 'tool_use')
        );
        if (tuEvent) {
            console.log('\n  包含 tool_use 的 assistant 事件（简略）:');
            for (const c of tuEvent.message.content) {
                if (c.type === 'tool_use') {
                    console.log(`    { type: "tool_use", name: "${c.name}", input: ${JSON.stringify(c.input)}, id: "${c.id}" }`);
                } else if (c.type === 'thinking') {
                    console.log(`    { type: "thinking", thinking: "${c.thinking.substring(0, 80)}..." }`);
                } else {
                    console.log(`    { type: "${c.type}" }`);
                }
            }
        }

        // 检查 usage 信息
        const usageEvents = r2.events.filter(e => e.type === 'assistant' && e.message?.usage);
        for (const ue of usageEvents) {
            console.log(`\n  usage: input_tokens=${ue.message.usage.input_tokens}, output_tokens=${ue.message.usage.output_tokens}`);
            if (ue.message.usage.cache_read_input_tokens) {
                console.log(`         cache_read=${ue.message.usage.cache_read_input_tokens}, cache_creation=${ue.message.usage.cache_creation_input_tokens}`);
            }
        }

        // 检查 cost
        const costEvents = r2.events.filter(e => e.type === 'result' && e.total_cost_usd !== undefined);
        for (const ce of costEvents) {
            console.log(`  cost: $${ce.total_cost_usd}`);
        }
    } else {
        // 没拿到 tool_use，分析原因
        console.log('\n  ⚠️ 未检测到原生 tool_use content block');
        console.log('  检查 assistant 事件结构：');
        const asst = r2.events.find(e => e.type === 'assistant');
        if (asst) {
            console.log(`  完整 assistant 事件:\n${JSON.stringify(asst, null, 2).substring(0, 1000)}`);
        }
        console.log('  继续测试可能失败');
    }

    // ======== 阶段 3：多轮 Tool Calling 循环 ========
    if (toolUses.length > 0) {
        console.log('\n' + '-'.repeat(70));
        console.log('阶段 3：多轮 Tool Calling 循环');
        console.log('-'.repeat(70) + '\n');

        const firstTool = toolUses[0];

        // 模拟外部执行结果
        let toolResult;
        if (firstTool.name === 'Read') {
            toolResult = JSON.stringify({ name: 'gcmp-models' });
        } else if (firstTool.name === 'Bash') {
            toolResult = 'package.json content';
        } else if (firstTool.name === 'Grep') {
            toolResult = 'line 42: "name": "gcmp-models"';
        } else {
            toolResult = '{"result": "mock output"}';
        }

        // 构建第二轮 messages：注入 tool_result
        const round2Msgs = [
            // 第一轮 user
            { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Read the file package.json and tell me its "name" field. Read the actual file content.' }] } },
            // 第一轮 assistant
            { type: 'user', message: { role: 'assistant', content: [{ type: 'text', text: extractText(r2.events).join(' ') }] } },
            // tool_result
            { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: firstTool.id, content: toolResult }] } },
            // 提示继续
            { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Based on the result above, what is the name field?' }] } },
        ];

        const r3 = await runWithMessages(round2Msgs);

        const texts3 = extractText(r3.events);
        const fullText3 = texts3.join(' ');

        report('第 2 轮收到 NDJSON', r3.events.length > 0, `${r3.events.length} 个事件`);
        report('第 2 轮输出有意义内容', fullText3.length > 20, `输出 ${fullText3.length} 字符`);
        report('第 2 轮包含 name 字段', /gcmp|name/i.test(fullText3));

        console.log(`  第 2 轮输出: "${fullText3.substring(0, 300)}"`);

        // ======== 阶段 4：并行工具调用 ========
        console.log('\n' + '-'.repeat(70));
        console.log('阶段 4（附加）：并行多工具调用行为');
        console.log('-'.repeat(70) + '\n');

        const r4 = await runWithMessages([
            { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Read both package.json and tsconfig.json in one response.' }] } }
        ]);

        const toolUses4 = findToolUses(r4.events);
        report(`第 1 次调用 tool_use 数量`, toolUses4.length > 0, `${toolUses4.length} 个`);
        if (toolUses4.length > 1) {
            console.log(`  并行工具（一次返回多个 tool_use）:`);
            for (const tu of toolUses4) {
                console.log(`    ${tu.name}(${JSON.stringify(tu.input)})`);
            }
        }
    }

    // ======== 总结 ========
    console.log('\n' + '='.repeat(70));
    console.log('验证总结');
    console.log('='.repeat(70) + '\n');

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    for (const r of results) {
        console.log(`  ${r.passed ? PASS : FAIL} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    }
    console.log(`\n通过: ${passed} | 失败: ${failed} | 总计: ${results.length}`);
    console.log(`总体结论: ${failed === 0 ? '✅ 原生事件流验证通过！可直接采用 Cline 方案' : '⚠️ 部分验证未通过，需进一步分析'}`);
    console.log('='.repeat(70));
}

main().catch(console.error);
