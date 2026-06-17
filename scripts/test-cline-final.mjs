/**
 * Cline SDK 方案最终验证
 *
 * 核心问题：当 --disallowedTools ALL + --max-turns 1 时，
 * Claude 是否会输出 XML <tool_use> 格式的工具调用文本？
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const ALL_DISALLOWED = 'Task,TaskOutput,Bash,Glob,Grep,Read,Edit,Write,NotebookEdit,WebFetch,TodoWrite,WebSearch,TaskStop,AskUserQuestion,Skill,EnterPlanMode,ExitPlanMode,EnterWorktree,ExitWorktree,CronCreate,CronDelete,CronList,ToolSearch,ScheduleWakeup';

function run(prompt) {
    return new Promise((resolve) => {
        const args = [
            '-p', prompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--disallowedTools', ALL_DISALLOWED,
            '--max-turns', '1',
            '--model', 'sonnet',
            '--no-session-persistence',
        ];
        const env = { ...process.env, CLAUDE_TERMINAL_WIDTH: '120', CLI_COLOR: '0' };
        delete env.ANTHROPIC_API_KEY;
        const proc = spawn('claude', args, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], env });
        let buf = '';
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; proc.kill(); resolve(buf); } }, 40000);
        proc.stdout.on('data', c => buf += c);
        proc.stderr.on('data', c => buf += '[stderr]' + c);
        proc.on('close', () => { if (!done) { done = true; clearTimeout(t); resolve(buf); } });
        proc.on('error', () => { if (!done) { done = true; clearTimeout(t); resolve(buf); } });
        proc.stdin.end();
    });
}

async function main() {
    console.log('='.repeat(70));
    console.log('Cline SDK 方案——最终验证');
    console.log(`参数: --disallowedTools ALL --max-turns 1 --model sonnet`);
    console.log('='.repeat(70));

    // 测试 1: 嵌入 XML 工具定义 → 要求 Claude 输出 tool_use XML
    console.log('\n【测试 1】XML 工具定义注入，要求返回 tool_use');
    console.log('-'.repeat(50));

    const p1 = `[SYSTEM]
You have a "calculate" tool defined below.

<tools>
<tool name="calculate">
<description>Execute math calculations</description>
<input_schema>{"type":"object","properties":{"expression":{"type":"string","description":"Math expression like 42*37"}},"required":["expression"]}</input_schema>
</tool>
</tools>

To use a tool, output exactly:
<tool_use>
<name>TOOL_NAME</name>
<input>{"key":"value"}</input>
</tool_use>

[USER]
What is 42 * 37? Please use the calculate tool. Reply with ONLY the <tool_use> XML.`;

    const raw1 = await run(p1);
    const lines1 = raw1.split('\n').filter(l => l.trim());
    let hasNativeToolUse = false, hasXmlInText = false, hasResult = false, textOutput = '';
    for (const l of lines1) {
        try {
            const e = JSON.parse(l.trim());
            if (e.type === 'assistant' && e.message?.content) {
                for (const c of e.message.content) {
                    if (c.type === 'text') {
                        textOutput = c.text;
                        if (/<tool_use/i.test(c.text)) hasXmlInText = true;
                    }
                    if (c.type === 'tool_use') hasNativeToolUse = true;
                }
            }
            if (e.type === 'result') hasResult = true;
        } catch { }
    }

    console.log(`Native tool_use block: ${hasNativeToolUse ? 'YES' : 'NO'}`);
    console.log(`XML <tool_use> in text: ${hasXmlInText ? 'YES' : 'NO'}`);
    console.log(`Has result event: ${hasResult}`);
    console.log(`Events: ${lines1.length}`);
    if (textOutput) console.log(`Text: ${textOutput.substring(0, 500)}`);

    // 测试 2: 不用 XML 工具定义，让 Claude 自己决定输出
    console.log('\n【测试 2】不加工具定义，Claude 能否输出有用结果');
    console.log('-'.repeat(50));

    const p2 = 'What is the name field in package.json? Just answer.';
    const raw2 = await run(p2);
    const lines2 = raw2.split('\n').filter(l => l.trim());
    let text2 = '';
    for (const l of lines2) {
        try {
            const e = JSON.parse(l.trim());
            if (e.type === 'assistant' && e.message?.content) {
                for (const c of e.message.content) {
                    if (c.type === 'text') text2 += c.text;
                }
            }
        } catch { }
    }
    console.log(`Has response: ${text2.length > 0}`);
    console.log(`Text: ${text2.substring(0, 300)}`);

    // 测试 3: Cline 的 JSON stdin 方式
    console.log('\n【测试 3】Cline 式的 JSON stdin 输入');
    console.log('-'.repeat(50));

    const p3 = await new Promise((resolve) => {
        const args = [
            '--system-prompt', 'You are a helpful assistant. Reply concisely.',
            '--output-format', 'stream-json',
            '--verbose',
            '--disallowedTools', ALL_DISALLOWED,
            '--max-turns', '1',
            '--model', 'sonnet',
            '-p', '',
        ];
        const env = {
            ...process.env, CLAUDE_TERMINAL_WIDTH: '120', CLI_COLOR: '0',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
        };
        delete env.ANTHROPIC_API_KEY;
        const proc = spawn('claude', args, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], env });
        let buf = '';
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; proc.kill(); resolve({ buf, events: [], stderr: '' }); } }, 25000);
        const events = [];
        let stderr = '';
        proc.stderr.on('data', c => stderr += c);
        const rl = createInterface({ input: proc.stdout });
        rl.on('line', l => { try { events.push(JSON.parse(l.trim())); } catch { } });
        rl.on('close', () => { if (!done) { done = true; clearTimeout(t); resolve({ buf, events, stderr }); } });
        proc.on('close', () => { if (!done) { done = true; clearTimeout(t); resolve({ buf, events, stderr }); } });
        // 写入 messages JSON 数组（Cline 方式）
        proc.stdin.write(JSON.stringify([{ role: 'user', content: [{ type: 'text', text: 'Say exactly: HELLO' }] }]));
        proc.stdin.end();
    });

    const asst3 = p3.events.find(e => e.type === 'assistant');
    const res3 = p3.events.find(e => e.type === 'result');
    let text3 = '';
    if (asst3?.message?.content) {
        for (const c of asst3.message.content) if (c.type === 'text') text3 += c.text;
    }
    console.log(`Has assistant: ${!!asst3}`);
    console.log(`Has result: ${!!res3}`);
    console.log(`Text: ${text3.substring(0, 200)}`);
    if (res3) {
        console.log(`Cost: $${res3.total_cost_usd}`);
        console.log(`Duration: ${res3.duration_ms}ms`);
    }

    // 总结
    console.log('\n' + '='.repeat(70));
    console.log('结论');
    console.log('='.repeat(70));
    console.log('');
    console.log(`Cline 方案披露的关键真相:`);
    console.log(`  1. --disallowedTools ALL 后，API 不知有工具`);
    console.log(`     → 不会返回原生 tool_use content block`);
    console.log(`  2. 工具定义通过 system prompt 的 <tools> XML 注入`);
    console.log(`  3. Claude 在纯文本中输出 <tool_use> XML`);
    console.log(`  4. Cline 的 task loop 从文本中解析 XML → 执行工具`);
    console.log(`  5. --system-prompt 传长文本有 Windows 参数限制`);
    console.log(`     → Cline 在 Windows 上使用 temp file + --system-prompt-file`);
    console.log('');
    console.log(`GCMP 实现方案：`);
    console.log(`  spawn('claude', ['--system-prompt-file', tmpFile,`);
    console.log(`    '--output-format', 'stream-json',`);
    console.log(`    '--disallowedTools', ALL,`);
    console.log(`    '--max-turns', '1',`);
    console.log(`    '--model', modelId,`);
    console.log(`    '-p', '']),`);
    console.log(`  stdin: JSON.stringify(messages) // Anthropic format`);
    console.log(`  stdout: parse JSON events → extract text → parse XML <tool_use>`);
    console.log('='.repeat(70));
}

main().catch(console.error);
