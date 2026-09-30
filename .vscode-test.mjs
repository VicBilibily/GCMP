import { defineConfig } from '@vscode/test-cli';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

function resolveVSCodeExecutablePath() {
    const override = process.env.VSCODE_EXECUTABLE_PATH;
    if (override) {
        const executablePath = resolve(override);
        if (existsSync(executablePath)) {
            return executablePath;
        }
        throw new Error(`VSCODE_EXECUTABLE_PATH 指向的文件不存在：${executablePath}`);
    }

    const candidates =
        process.platform === 'win32' ?
            [
                join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
                join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
                join(process.env.ProgramFiles ?? '', 'Microsoft VS Code', 'Code.exe'),
                join(process.env.ProgramFiles ?? '', 'Microsoft VS Code Insiders', 'Code - Insiders.exe')
            ]
            : process.platform === 'darwin' ?
                [
                    join(homedir(), 'Applications', 'Visual Studio Code.app', 'Contents', 'MacOS', 'Electron'),
                    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
                    join(homedir(), 'Applications', 'Visual Studio Code - Insiders.app', 'Contents', 'MacOS', 'Electron'),
                    '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron'
                ]
                : ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code', '/usr/share/code/code'];
    const executableNames = process.platform === 'win32' ? ['Code.exe', 'code.cmd'] : ['code', 'code-insiders'];
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (directory) {
            candidates.push(...executableNames.map(name => join(directory.replace(/^"|"$/g, ''), name)));
        }
    }

    const executablePath = candidates.find(candidate => existsSync(candidate));
    if (!executablePath) {
        throw new Error('未找到本机安装的 VS Code；可通过 VSCODE_EXECUTABLE_PATH 指定可执行文件。');
    }
    return executablePath;
}

// F5 的配置发现进程先于测试宿主退出，隔离目录不能绑定发现进程的生命周期。
const testRoot = fileURLToPath(new URL('./.vscode-test/scope', import.meta.url));
const workspaceFile = join(testRoot, 'scope.code-workspace');
const vscodeExecutablePath = resolveVSCodeExecutablePath();
for (const folder of ['first', 'second']) {
    mkdirSync(join(testRoot, folder), { recursive: true });
}
try {
    writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: 'first' }, { path: 'second' }] }), { flag: 'wx' });
} catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
        throw error;
    }
}

export default defineConfig({
    files: 'out/integration/**/*.test.js',
    extensionDevelopmentPath: '.',
    useInstallation: { fromPath: vscodeExecutablePath },
    skipExtensionDependencies: true,
    workspaceFolder: workspaceFile,
    env: { GCMP_TEST_ROOT: testRoot },
    launchArgs: [
        '--disable-workspace-trust',
        '--enable-proposed-api=vicanent.gcmp',
        '--locale=en',
        `--user-data-dir=${join(testRoot, 'user-data')}`
    ],
    mocha: {
        ui: 'tdd',
        timeout: 20000
    }
});
