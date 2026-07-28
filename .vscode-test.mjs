import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'out/integration/**/*.test.js',
    extensionDevelopmentPath: '.',
    version: 'stable',
    launchArgs: ['--enable-proposed-api=vicanent.gcmp'],
    mocha: {
        ui: 'tdd',
        timeout: 20000
    }
});
