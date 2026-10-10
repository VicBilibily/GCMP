/* eslint-disable no-undef, @typescript-eslint/no-require-imports */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// 扩展目录（本脚本所在目录）；仓库根用于解析 node_modules 与 chat-lib 资源
const EXT_ROOT = __dirname;
const REPO_ROOT = path.join(__dirname, '../..');
const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev');

//#region 复制 chat-lib 相关的资源文件
// 与主扩展 esbuild.config.js 的 postinstall 资源复制逻辑保持一致
const treeSitterGrammars = [
    'tree-sitter-c-sharp',
    'tree-sitter-cpp',
    'tree-sitter-go',
    'tree-sitter-javascript', // Also includes jsx support
    'tree-sitter-python',
    'tree-sitter-ruby',
    'tree-sitter-typescript',
    'tree-sitter-tsx',
    'tree-sitter-java',
    'tree-sitter-rust',
    'tree-sitter-php'
];

async function fileExists(filePath) {
    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function platformDir() {
    try {
        // 查找 @vscode/chat-lib 中的 tokenizer 文件（依赖安装在仓库根）
        const chatlibModulePath = require.resolve('@vscode/chat-lib', { paths: [REPO_ROOT] });
        // chat-lib 的根目录是 dist/src 的父目录
        const chatlibRoot = path.join(path.dirname(chatlibModulePath), '../..');

        // 先尝试查找平台特定的路径
        const platformPath = path.join(chatlibRoot, 'dist/src/_internal/platform');
        if (await fileExists(platformPath)) {
            return platformPath;
        }

        // 尝试查找 chat-lib 的直接 dist 目录
        const distPath = path.join(chatlibRoot, 'dist');
        if (await fileExists(distPath)) {
            return distPath;
        }

        throw new Error('Chat-lib tokenizer directory not found');
    } catch (error) {
        throw new Error('Required tokenizer assets unavailable', { cause: error });
    }
}

function treeSitterWasmDir() {
    try {
        const modulePath = path.dirname(require.resolve('@vscode/tree-sitter-wasm', { paths: [REPO_ROOT] }));
        return modulePath;
    } catch (error) {
        throw new Error('Required tree-sitter assets unavailable', { cause: error });
    }
}

async function copyStaticAssets(srcpaths, dst) {
    await Promise.all(srcpaths.map(async srcpath => {
        const src = path.isAbsolute(srcpath) ? srcpath : path.join(REPO_ROOT, srcpath);
        const dest = path.join(EXT_ROOT, dst, path.basename(srcpath));
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(src, dest);
        console.log(`Copied: ${path.relative(EXT_ROOT, dest)}`);
    }));
}

async function copyBuildAssets() {
    console.log('Copying build assets...');
    const platform = await platformDir();
    const wasm = treeSitterWasmDir();

    const filesToCopy = [
        path.join(platform, 'tokenizer/node/cl100k_base.tiktoken'),
        path.join(platform, 'tokenizer/node/o200k_base.tiktoken'),
        ...treeSitterGrammars.map(grammar => path.join(wasm, `${grammar}.wasm`)),
        path.join(wasm, 'tree-sitter.wasm')
    ];

    await copyStaticAssets(filesToCopy, 'dist');
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
// gcmpServices 共享 bundle 外置插件
//
// extension.js 与 copilot.bundle.js 是两个独立产物，若各自内嵌 gcmpServices
// 会导致模块级注入状态（injectedServices）互不可见。此插件把源码内对
// gcmpServices 的 import 重写为运行时 require('./gcmpServices.bundle.js')，
// 两个产物经 Node 模块缓存共享同一实例。
// ========================================================================
const gcmpServicesExternalPlugin = {
    name: 'gcmp-services-shared',
    setup(build) {
        build.onResolve({ filter: /(^|[/\\])gcmpServices$/ }, (_args) => {
            // 两个产物均位于 dist/ 目录，相对说明符统一指向 dist/gcmpServices.bundle.js
            return { path: './gcmpServices.bundle.js', external: true };
        });
    }
};

// ========================================================================
// 公共构建选项（与主扩展 esbuild.config.js 保持一致）
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
// 主入口构建选项
// - 不包含 @vscode/chat-lib 相关的重型依赖
// - 使用轻量级的 InlineCompletionShim 进行延迟加载
// - gcmpServices 外置为共享 bundle（运行时 require）
// ========================================================================
/** @type {import('esbuild').BuildOptions} */
const extensionBuildOptions = {
    ...commonOptions,
    entryPoints: [path.join(EXT_ROOT, 'src/extension.ts')],
    outfile: path.join(EXT_ROOT, 'dist/extension.js'),
    tsconfig: path.join(EXT_ROOT, 'tsconfig.json'),
    plugins: [...commonOptions.plugins, gcmpServicesExternalPlugin]
};

// ========================================================================
// Copilot 模块构建选项
// - 包含 @vscode/chat-lib 和相关重型依赖
// - 在首次触发补全时延迟加载
// - gcmpServices 外置为共享 bundle（与 extension.js 共享同一实例）
// ========================================================================
/** @type {import('esbuild').BuildOptions} */
const copilotBuildOptions = {
    ...commonOptions,
    entryPoints: [path.join(EXT_ROOT, 'src/copilot/copilot.bundle.ts')],
    outfile: path.join(EXT_ROOT, 'dist/copilot.bundle.js'),
    tsconfig: path.join(EXT_ROOT, 'tsconfig.json'),
    plugins: [...commonOptions.plugins, gcmpServicesExternalPlugin]
};

// ========================================================================
// gcmpServices 共享模块构建选项
// - 被上述两个 bundle 运行时 require，持有唯一的注入状态
// ========================================================================
/** @type {import('esbuild').BuildOptions} */
const gcmpServicesBuildOptions = {
    ...commonOptions,
    entryPoints: [path.join(EXT_ROOT, 'src/gcmpServices.ts')],
    outfile: path.join(EXT_ROOT, 'dist/gcmpServices.bundle.js'),
    tsconfig: path.join(EXT_ROOT, 'tsconfig.json')
};

// ========================================================================
// 构建函数
// ========================================================================
async function build() {
    try {
        const buildConfigs = [gcmpServicesBuildOptions, extensionBuildOptions, copilotBuildOptions];

        if (isWatch) {
            // Watch 模式
            console.log('GCMP_WATCH_START');
            await copyBuildAssets();

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
            console.log(`Cleaning ${path.join(EXT_ROOT, 'dist')} directory...`);
            const distDir = path.join(EXT_ROOT, 'dist');
            if (fs.existsSync(distDir)) {
                await fs.promises.rm(distDir, { recursive: true, force: true });
                console.log('dist directory cleaned.');
            } else {
                console.log('No dist directory to clean.');
            }

            console.log(`Building ${buildConfigs.length} bundles...`);
            const startTime = Date.now();

            await Promise.all(buildConfigs.map(config => esbuild.build(config)));

            const buildTime = Date.now() - startTime;
            console.log(`Build completed successfully in ${buildTime}ms.`);

            console.log('Built bundles:');
            buildConfigs.forEach(config => {
                if (config.outfile) {
                    console.log(`  - ${path.relative(EXT_ROOT, config.outfile)}`);
                }
            });

            await copyBuildAssets();

            console.log('Asset copying completed.');
        }
    } catch (error) {
        console.error('Build failed:', error);
        process.exit(1);
    }
}

build();
