/* eslint-disable no-undef, @typescript-eslint/no-require-imports */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev');
const buildIntegrationTests = process.argv.includes('--integration-tests');


//#region 复制 tokenizer 资源文件（主扩展 tokenCounter 使用）
// FIM/NES 的 chat-lib 资源（cl100k tiktoken + tree-sitter wasm）已随拆分
// 移至 extensions/gcmp-fim-nes/esbuild.config.js 的资源复制逻辑
const REPO_ROOT = path.join(__dirname, '.');

async function fileExists(filePath) {
    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function copyStaticAssets(srcpaths, dst) {
    await Promise.all(srcpaths.map(async srcpath => {
        const src = path.join(REPO_ROOT, srcpath);
        const dest = path.join(REPO_ROOT, dst, path.basename(srcpath));
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(src, dest);
        const relativeDest = path.relative(REPO_ROOT, dest);
        console.log(`Copied: ${relativeDest}`);
    }));
}

async function platformDir() {
    try {
        // 查找 @vscode/chat-lib 中的 tokenizer 文件
        const chatlibModulePath = require.resolve('@vscode/chat-lib');
        // chat-lib 的根目录是 dist/src 的父目录
        const chatlibRoot = path.join(path.dirname(chatlibModulePath), '../..');

        // 先尝试查找平台特定的路径
        const platformPath = path.join(chatlibRoot, 'dist/src/_internal/platform');
        if (await fileExists(platformPath)) {
            return path.relative(REPO_ROOT, platformPath);
        }

        // 尝试查找 chat-lib 的直接 dist 目录
        const distPath = path.join(chatlibRoot, 'dist');
        if (await fileExists(distPath)) {
            return path.relative(REPO_ROOT, distPath);
        }

        throw new Error('Chat-lib tokenizer directory not found');
    } catch (error) {
        throw new Error('Required tokenizer assets unavailable', { cause: error });
    }
}

async function copyBuildAssets() {
    console.log('Copying build assets...');
    const platform = await platformDir();

    await copyStaticAssets([`${platform}/tokenizer/node/o200k_base.tiktoken`], 'dist');
}
//#endregion

// 自定义插件处理 ?raw 导入（内嵌资源，不进行 minify）
const rawPlugin = {
    name: 'raw-import',
    setup(build) {
        build.onResolve({ filter: /\?raw$/ }, (args) => {
            return {
                path: args.path.replace(/\?raw$/, ''),
                namespace: 'raw-file',
                pluginData: {
                    resolveDir: args.resolveDir
                }
            };
        });
        build.onLoad({ filter: /.*/, namespace: 'raw-file' }, async (args) => {
            const filePath = path.join(args.pluginData.resolveDir, args.path);
            const contents = await fs.promises.readFile(filePath, 'utf8');
            return {
                contents: `export default ${JSON.stringify(contents)};`,
                loader: 'js'
            };
        });
    }
};


// ========================================================================
// 公共构建选项
// ========================================================================
const commonOptions = {
    bundle: true,
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    sourcemap: isDev,
    minify: !isDev,
    // 使用 mainFields 优先选择 ESM 模块格式
    // 这解决了 jsonc-parser UMD 模块的相对路径问题
    mainFields: ['module', 'main'],
    // 确保正确解析模块（.ts 优先于 .tsx）
    resolveExtensions: ['.ts', '.tsx', '.js', '.mjs', '.json'],
    // 添加自定义插件
    plugins: [rawPlugin],
    // 日志级别
    logLevel: 'info'
};

// ========================================================================
// 主扩展构建选项
// - FIM/NES 内联补全已拆分至独立扩展 extensions/gcmp-fim-nes
// - 主扩展不再包含 @vscode/chat-lib 及其延迟加载的 copilot.bundle
// ========================================================================
/** @type {import('esbuild').BuildOptions} */
const extensionBuildOptions = {
    ...commonOptions,
    entryPoints: ['./src/extension.ts'],
    outfile: 'dist/extension.js'
};

// ========================================================================
// UI WebView 构建选项
// ========================================================================
/**
 * 构建 UI WebView 的编译配置
 * 扫描 ui 目录下所有包含 app.ts 的文件夹，生成对应的构建选项
 * @returns {import('esbuild').BuildOptions[]} 构建配置数组
 */
function buildUiConfigs() {
    const uiDir = path.join(REPO_ROOT, 'src/ui');
    const configs = [];

    // 自定义插件处理 CSS 内联（处理 .less 文件）
    const inlineLessPlugin = {
        name: 'inline-less',
        setup(build) {
            // 处理所有 .less 文件（自动内联）
            build.onResolve({ filter: /\.less$/ }, (args) => {
                return {
                    path: args.path,
                    namespace: 'inline-less',
                    pluginData: {
                        resolveDir: args.resolveDir
                    }
                };
            });

            // 处理 .less 文件
            build.onLoad({ filter: /.*/, namespace: 'inline-less' }, async (args) => {
                const filePath = path.join(args.pluginData.resolveDir, args.path);
                const less = require('less');
                const lessContent = await fs.promises.readFile(filePath, 'utf8');
                const result = await less.render(lessContent, {
                    filename: filePath,
                    paths: [path.dirname(filePath)], // 搜索路径，用于 @import
                    javascriptEnabled: true,
                    compress: !isDev // 生产模式下压缩 CSS
                });

                // 返回一个模块，导出 CSS 字符串并自动注入到页面
                return {
                    contents: `
                    const css = ${JSON.stringify(result.css)};
                    if (typeof document !== 'undefined') {
                        const style = document.createElement('style');
                        style.textContent = css;
                        document.head.appendChild(style);
                    }
                    export default {};
                `,
                    loader: 'js'
                };
            });
        }
    };

    // UI 构建选项（浏览器目标）
    const uiBuildOptions = {
        bundle: true,
        format: 'iife',
        platform: 'browser',
        sourcemap: isDev,
        minify: !isDev,
        treeShaking: true,
        resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
        logLevel: 'info',
        plugins: [inlineLessPlugin],
        tsconfig: './tsconfig.ui.json',
        define: {
            'process.env.NODE_ENV': isDev ? '"development"' : '"production"'
        }
    };

    function scan(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const appTsPath = path.join(fullPath, 'app.ts');
                if (fs.existsSync(appTsPath)) {
                    const folderName = path.basename(fullPath);
                    configs.push({
                        ...uiBuildOptions,
                        entryPoints: [appTsPath],
                        outfile: `dist/ui/${folderName}.js`
                    });
                }
                // 递归扫描子目录
                scan(fullPath);
            }
        }
    }

    scan(uiDir);
    return configs;
}

function buildIntegrationTestConfigs() {
    const integrationDir = path.join(REPO_ROOT, 'integration');
    if (!fs.existsSync(integrationDir)) {
        return [];
    }

    const configs = [];

    function scan(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scan(fullPath);
                continue;
            }

            if (!entry.isFile() || !entry.name.endsWith('.test.ts')) {
                continue;
            }

            const relativePath = path.relative(integrationDir, fullPath).replace(/\.ts$/, '.js');
            configs.push({
                ...commonOptions,
                entryPoints: [fullPath],
                outfile: path.join('out', 'integration', relativePath),
                minify: false,
                tsconfig: './tsconfig.vscode-test.json'
            });
        }
    }

    scan(integrationDir);
    return configs;
}


// ========================================================================
// 构建函数
// ========================================================================
async function build() {
    try {
        const buildConfigs = buildIntegrationTests
            ? buildIntegrationTestConfigs()
            : [extensionBuildOptions, ...buildUiConfigs()];

        if (buildConfigs.length === 0) {
            console.log(buildIntegrationTests ? 'No integration test bundles to build.' : 'No bundles to build.');
            return;
        }

        const cleanTarget = buildIntegrationTests ? path.join('out', 'integration') : 'dist';

        if (isWatch) {
            // Watch 模式
            console.log('GCMP_WATCH_START');
            if (!buildIntegrationTests) {
                await copyBuildAssets();
            }

            const contexts = [];

            for (const config of buildConfigs) {
                const ctx = await esbuild.context(config);
                contexts.push(ctx);
                await ctx.watch();
                console.log(`Watching: ${config.outfile}`);
            }

            await Promise.all(contexts.map(ctx => ctx.rebuild()));
            console.log('GCMP_WATCH_READY');
        } else {
            console.log(`Cleaning ${cleanTarget} directory...`);
            if (fs.existsSync(cleanTarget)) {
                await fs.promises.rm(cleanTarget, { recursive: true, force: true });
                console.log(`${cleanTarget} directory cleaned.`);
            } else {
                console.log(`No ${cleanTarget} directory to clean.`);
            }

            console.log(`Building ${buildConfigs.length} bundles...`);
            const startTime = Date.now();

            const allConfigs = buildConfigs.map(config => esbuild.build(config));

            await Promise.all(allConfigs);

            const buildTime = Date.now() - startTime;
            console.log(`Build completed successfully in ${buildTime}ms.`);

            console.log('Built bundles:');
            buildConfigs.forEach(config => {
                if (config.outfile) {
                    console.log(`  - ${config.outfile}`);
                }
            });

            if (!buildIntegrationTests) {
                await copyBuildAssets();

                console.log('Asset copying completed.');
            }
        }
    } catch (error) {
        console.error('Build failed:', error);
        process.exit(1);
    }
}

build();
