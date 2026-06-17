/**
 * Cline 方案完整验证
 * --disallowedTools ALL + --max-turns 1 + -p + XML 注入
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const CLAUDE_CMD = 'claude';
const TIMEOUT = 60000;
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
        const proc = spawn(CLAUDE_CMD, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
            env: { ...process.env, CLAUDE_TERMINAL_WIDTH: '120', CLI_COLOR: '0' }
        });
        delete proc.env?.ANTHROPIC_API_KEY;

        const events = [];
        let stderr = '';
        let done = false;

        const X = setTimeout(() => { if (!done) { done = true; proc.kill(); resolve({ events, stderr }); } }, TIMEOUT);

        proc.stderr.on('data', c => { stderr += c; });
        const rl = createInterface({ input: proc.stdout });
        rl.on('line', l => { try { events.push(JSON.parse(l.trim())); } catch { } });
        rl.on('close', () => { if (!done) { done = true; clearTimeout(X); resolve({ events, stderr }); } });
        proc.on('error', () => { if (!done) { done = true; clearTimeout(X); resolve({ events, stderr }); } });
        proc.on('exit', () => { if (!done) { done = true; clearTimeout(X); resolve({ events, stderr }); } });
        proc.stdin.end();
    });
}

function getText(events) {
    const t = [];
    for (const e of events) {
        if (e.type === 'assistant' && e.message?.content) {
            for (const c of e.message.content) if (c.type === 'text') t.push(c.text);
        }
        if (e.type === 'result' && e.result) t.push(e.result);
    }
    return t.join(' ');
}

async function main() {
    console.log('='.repeat(70));
    console.log('Cline 方案验证：--disallowedTools ALL + XML 注入');
    console.log('='.repeat(70));

    // Test 1: XML tool_use generation
    console.log('\n--- Test 1: XML <tool_use> generation ---\n');
    const p1 = `You have a "calculate" tool. When you need to calculate, output:
<tool_use>
<name>calculate</name>
<input>{"expression": "EXPRESSION"}</input>
</tool_use>

What is 42 * 37? Use the calculate tool.`;
    const r1 = await run(p1);
    const t1 = getText(r1.events);
    const hasXml = /<tool_use>[\s\S]*?<\/tool_use>/i.test(t1);
    const nameMatch = t1.match(/<name>([^<]+)<\/name>/i);
    console.log(`  <tool_use> XML: ${hasXml ? 'YES' : 'NO'}`);
    console.log(`  Tool name: ${nameMatch ? nameMatch[1] : '(none)'}`);
    console.log(`  Text: "${t1.substring(0, 300)}"`);
    if (r1.stderr) console.log(`  STDERR: ${r1.stderr.substring(0, 200)}`);

    // Test 2: tool_result understanding
    console.log('\n--- Test 2: <tool_result> understanding ---\n');
    const p2 = `You have a "calculate" tool. Result: <tool_result><name>calculate</name><output>The answer is 1554</output></tool_result>. What is 42 * 37?`;
    const r2 = await run(p2);
    const t2 = getText(r2.events);
    const has1554 = /1554/i.test(t2);
    console.log(`  Mentions 1554: ${has1554 ? 'YES' : 'NO'}`);
    console.log(`  Text: "${t2.substring(0, 300)}"`);

    // Test 3: metadata
    console.log('\n--- Test 3: metadata ---\n');
    const r3 = await run('Say HELLO');
    const asst = r3.events.find(e => e.type === 'assistant');
    const res = r3.events.find(e => e.type === 'result');
    if (asst?.message?.usage) {
        console.log(`  Usage: input_tokens=${asst.message.usage.input_tokens}, output_tokens=${asst.message.usage.output_tokens}`);
        if (asst.message.usage.cache_read_input_tokens) console.log(`  Cache: read=${asst.message.usage.cache_read_input_tokens}`);
    }
    if (res?.total_cost_usd !== undefined) console.log(`  Cost: $${res.total_cost_usd}`);

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('Summary');
    console.log('='.repeat(70));
    console.log(`  <tool_use> XML: ${hasXml ? 'PASS' : 'FAIL'}`);
    console.log(`  tool_result understanding: ${has1554 ? 'PASS' : 'FAIL'}`);
    console.log(`  Overall: ${hasXml && has1554 ? 'PASS - approach works' : 'INCOMPLETE'}`);
    console.log('='.repeat(70));
}

main().catch(console.error);
