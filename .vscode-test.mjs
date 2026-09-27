import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

// F5 的配置发现进程先于测试宿主退出，隔离目录不能绑定发现进程的生命周期。
const testRoot = fileURLToPath(new URL('./.vscode-test/scope', import.meta.url));
const workspaceFile = join(testRoot, 'scope.code-workspace');
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
    version: '1.133.0',
    workspaceFolder: workspaceFile,
    env: { GCMP_TEST_ROOT: testRoot },
    launchArgs: [
        '--disable-workspace-trust',
        '--enable-proposed-api=vicanent.gcmp',
        `--user-data-dir=${join(testRoot, 'user-data')}`
    ],
    mocha: {
        ui: 'tdd',
        timeout: 20000
    }
});
