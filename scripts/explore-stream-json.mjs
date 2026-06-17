/**
 * 探索 Claude CLI 原生 stream-json 事件流
 *
 * 关键问题：
 * 1. 不加 --tools ""，CLI 内部工具执行是否产生原生 tool_use content block？
 * 2. 能否通过 stdin/stdout 事件流实现「CLI→API→tool_use→外部执行→tool_result→继续」的全事件循环？
 * 3. 与 XML 注入方案相比，原生事件流能带来哪些好处？
 */
import { spawn } from 'node:child_process';

const CLAUDE_CMD = 'claude';

function runTest(label, firstMsg, secondMsg = null, delayMs = 12000) {
    return new Promise((resolve) => {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`[${label}]`);
        console.log(`${'='.repeat(70)}`);

        const proc = spawn(CLAUDE_CMD, [
            '-p', '',
            '--output-format', 'stream-json',
            '--input-format', 'stream-json',
            '--verbose',
            '--no-session-persistence'
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
            env: { ...process.env, CLAUDE_TERMINAL_WIDTH: '120', CLI_COLOR: '0' }
        });

        const allEvents = [];
        let buf = '';
        let totalLines = 0;

        proc.stdout.on('data', (chunk) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                totalLines++;

                try {
                    const evt = JSON.parse(trimmed);
                    allEvents.push(evt);

                    const contentTypes = evt.message?.content?.map?.(c => c.type) || [];
                    const hasToolUse = contentTypes.includes('tool_use');
                    const toolInfo = evt.message?.content?.filter?.(c => c.type === 'tool_use')
                        ?.map?.(c => `${c.name}(${JSON.stringify(c.input)})`) || [];

                    const parts = [
                        `[${String(allEvents.length).padStart(2)}]`,
                        evt.type,
                        evt.subtype ? `<${evt.subtype}>` : '',
                        contentTypes.length ? `content:[${contentTypes.join(',')}]` : '',
                        hasToolUse ? ` 🛠️ ${toolInfo.join('; ')}` : '',
                        evt.result ? `result:${evt.result.substring(0, 140)}` : '',
                        evt.stop_reason ? `stop:${evt.stop_reason}` : '',
                        evt.is_error !== undefined ? `error:${evt.is_error}` : ''
                    ].filter(Boolean).join(' ');

                    console.log(parts);
                } catch {
                    console.log(`  [parse error] ${trimmed.substring(0, 100)}`);
                }
            }
        });

        let stderrBuf = '';
        proc.stderr.on('data', (c) => { stderrBuf += c.toString(); });

        const timeout = setTimeout(() => {
            proc.kill('SIGTERM');
            console.log(`\n--- 共 ${allEvents.length} 个事件, ${totalLines} 行 NDJSON ---`);
            resolve({ allEvents, stderr: stderrBuf });
        }, 35000);

        proc.on('exit', (code) => {
            clearTimeout(timeout);
            console.log(`\n--- exit=${code}, ${allEvents.length} 个事件 ---`);
            resolve({ allEvents, stderr: stderrBuf });
        });
        proc.on('error', (err) => {
            clearTimeout(timeout);
            resolve({ allEvents, stderr: stderrBuf + '\n' + err.message });
        });

        console.log(`>>> ${JSON.stringify(firstMsg).substring(0, 150)}`);
        proc.stdin.write(JSON.stringify(firstMsg) + '\n');

        if (secondMsg) {
            setTimeout(() => {
                console.log(`>>> ${JSON.stringify(secondMsg).substring(0, 150)}`);
                proc.stdin.write(JSON.stringify(secondMsg) + '\n');
            }, delayMs);
        }

        setTimeout(() => { try { proc.stdin.write('\n'); } catch { } }, delayMs + 1000);
    });
}

async function main() {
    console.log('='.repeat(70));
    console.log('Claude CLI 原生 Stream-JSON 事件流深度探索');
    console.log('(不加 --tools "" — 观察内置工具产生的原生 tool_use 事件)');
    console.log('='.repeat(70));

    // 测试 1: Read file 请求，看是否产生原生 tool_use content block
    const r1 = await runTest(
        '测试1：Read package.json - 原生 tool_use 事件',
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Read the file package.json and tell me its name field' }] } }
    );

    // 分析事件
    const hasNativeToolUse = r1.allEvents.some(e =>
        e.message?.content?.some?.(c => c.type === 'tool_use')
    );

    const allBlockTypes = new Set();
    for (const evt of r1.allEvents) {
        if (evt.message?.content) {
            for (const c of evt.message.content) allBlockTypes.add(c.type);
        }
    }

    console.log(`\n--- 分析 ---`);
    console.log(`content block 类型: [${[...allBlockTypes].join(', ')}]`);
    console.log(`原生 tool_use block: ${hasNativeToolUse ? '✅ 出现' : '❌ 未出现'}`);

    // 打印完整事件时间线
    console.log('\n事件时间线:');
    for (const evt of r1.allEvents) {
        const line = [evt.type];
        if (evt.subtype) line.push(`(${evt.subtype})`);
        if (evt.message?.content?.length) {
            const types = evt.message.content.map(c => c.type);
            line.push(`content[${types.join(',')}]`);
            // 如果有 tool_use，打印详细信息
            const toolBlocks = evt.message.content.filter(c => c.type === 'tool_use');
            for (const tb of toolBlocks) {
                line.push(`\n    tool: ${tb.name}(${JSON.stringify(tb.input)})`);
                line.push(`    id: ${tb.id}`);
            }
        }
        if (evt.stop_reason) line.push(`stop=${evt.stop_reason}`);
        if (evt.result) line.push(`result_len=${evt.result.length}`);
        if (evt.is_error) line.push(`ERROR`);
        console.log('  ' + line.join(' '));
    }

    // 如果没有原生 tool_use，检查是否有其他方式获得工具调用信息
    if (!hasNativeToolUse) {
        // 检查 result 中是否包含 tool_use XML
        const resultEvents = r1.allEvents.filter(e => e.type === 'result');
        for (const r of resultEvents) {
            if (r.result && /<tool_use/i.test(r.result)) {
                console.log(`\n⚠️ result 文本中包含 <tool_use> XML (非原生 tool_use block)`);
            }
        }
        console.log(`\n结论：--input-format stream-json 模式下，CLI 内部执行完完整 agent loop 后才输出。`);
        console.log(`      tool_use 不暴露为原生 JSON content block，而是 CLI 内部执行并消化。`);
        console.log(`      这与 --tools "" 的结果一致：最终输出流没有中间 tool_use 事件。`);
        console.log(`      \n因此，必须使用 XML 注入方案：在 system prompt 中声明工具，`);
        console.log(`      然后在 result 文本中解析 <tool_use> XML。`);
    } else {
        // 继续测试 tool_result 注入
        console.log(`\n🎯 原生 tool_use block 出现了！测试 tool_result 事件注入...`);
    }
}

main().catch(console.error);
