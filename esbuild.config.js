/* eslint-disable no-undef, @typescript-eslint/no-require-imports */
const esbuild = require('esbuild');
const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: ['./src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    sourcemap: isDev,
    minify: !isDev,
    // 使用 mainFields 优先选择 ESM 模块格式
    // 这解决了 jsonc-parser UMD 模块的相对路径问题
    mainFields: ['module', 'main'],
    // 确保正确解析模块
    resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
    // 日志级别
    logLevel: 'info'
};

async function build() {
    try {
        if (isWatch) {
            const ctx = await esbuild.context(buildOptions);
            await ctx.watch();
            console.log('Watching for changes...');
        } else {
            await esbuild.build(buildOptions);
            console.log('Build completed successfully.');
        }
    } catch (error) {
        console.error('Build failed:', error);
        process.exit(1);
    }
}

build();
