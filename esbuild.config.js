/* eslint-disable no-undef, @typescript-eslint/no-require-imports */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev');


//#region 复制 chat-lib 相关的资源文件
// postinstall.ts 中的资源复制逻辑
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

const REPO_ROOT = path.join(__dirname, '.');

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

        console.log('Chat-lib directory not found, skipping tokenizer files');
        return null;
    } catch {
        console.log('Could not resolve @vscode/chat-lib, skipping tokenizer files');
        return null;
    }
}

function treeSitterWasmDir() {
    try {
        const modulePath = path.dirname(require.resolve('@vscode/tree-sitter-wasm'));
        return path.relative(REPO_ROOT, modulePath);
    } catch {
        console.warn('Could not resolve @vscode/tree-sitter-wasm, skipping tree-sitter files');
        return null;
    }
}

async function copyStaticAssets(srcpaths, dst) {
    await Promise.all(srcpaths.map(async srcpath => {
        const src = path.join(REPO_ROOT, srcpath);
        const dest = path.join(REPO_ROOT, dst, path.basename(srcpath));
        try {
            await fs.promises.mkdir(path.dirname(dest), { recursive: true });
            await fs.promises.copyFile(src, dest);
            // 只输出目标文件相对于项目根目录的路径
            const relativeDest = path.relative(REPO_ROOT, dest);
            console.log(`Copied: ${relativeDest}`);
        } catch {
            console.warn(`Failed to copy ${srcpath}`);
        }
    }));
}

async function copyBuildAssets() {
    console.log('Copying build assets...');
    const platform = await platformDir();
    const wasm = treeSitterWasmDir();

    const filesToCopy = [];

    // 处理 tokenizer 文件
    if (platform) {
        const vendoredTiktokenFiles = [
            `${platform}/tokenizer/node/cl100k_base.tiktoken`,
            `${platform}/tokenizer/node/o200k_base.tiktoken`
        ].filter(file => fs.existsSync(path.join(REPO_ROOT, file)));

        filesToCopy.push(...vendoredTiktokenFiles);
    }

    // 处理 tree-sitter 文件
    if (wasm) {
        const treeSitterFiles = [
            ...treeSitterGrammars.map(grammar => `${wasm}/${grammar}.wasm`),
            `${wasm}/tree-sitter.wasm`
        ].filter(file => fs.existsSync(path.join(REPO_ROOT, file)));

        filesToCopy.push(...treeSitterFiles);
    }

    if (filesToCopy.length === 0) {
        console.log('No build assets found to copy');
        return;
    }

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
// - 不包含 @vscode/chat-lib 相关的重型依赖
// - 使用轻量级的 InlineCompletionShim 进行延迟加载
// ========================================================================
/** @type {import('esbuild').BuildOptions} */
const extensionBuildOptions = {
    ...commonOptions,
    entryPoints: ['./src/extension.ts'],
    outfile: 'dist/extension.js',
    // 排除 copilot.bundle 模块和 @vscode/chat-lib，避免重复打包
    external: [...commonOptions.external, './copilot.bundle', '@vscode/chat-lib']
};

// ========================================================================
// Copilot 模块构建选项
// - 包含 @vscode/chat-lib 和相关重型依赖
// - 在首次触发补全时延迟加载
// ========================================================================
/** @type {import('esbuild').BuildOptions} */
const copilotBuildOptions = {
    ...commonOptions,
    entryPoints: ['./src/copilot/copilot.bundle.ts'],
    outfile: 'dist/copilot.bundle.js',
    // 只排除 vscode 本身，保留 @vscode/chat-lib 及其依赖，确保被打包到 bundle 中
    external: ['vscode']
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
        tsconfig: './tsconfig.json',
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


// ========================================================================
// 构建函数
// ========================================================================
async function build() {
    try {
        // 基础构建配置
        const baseConfigs = [
            extensionBuildOptions,
            copilotBuildOptions
        ];

        // 构建 UI WebView 的编译配置
        const uiConfigs = buildUiConfigs();

        if (isWatch) {
            // Watch 模式
            console.log('Starting watch mode...');

            const contexts = [];

            // 添加基础配置
            for (const config of baseConfigs) {
                const ctx = await esbuild.context(config);
                contexts.push(ctx);
                await ctx.watch();
            }

            // 添加 UI 配置
            for (const config of uiConfigs) {
                const ctx = await esbuild.context(config);
                contexts.push(ctx);
                await ctx.watch();
                console.log(`Watching: ${config.outfile}`);
            }

            console.log(`Watching for changes in ${contexts.length} bundles...`);
            await Promise.all(contexts.map(ctx => ctx.watch()));
        } else {
            // 构建前清理 dist 目录
            console.log('Cleaning dist directory...');
            if (fs.existsSync('dist')) {
                await fs.promises.rm('dist', { recursive: true, force: true });
                console.log('Dist directory cleaned.');
            } else {
                console.log('No dist directory to clean.');
            }

            // 并行构建所有配置
            console.log(`Building ${baseConfigs.length + uiConfigs.length} bundles...`);
            const startTime = Date.now();

            const allConfigs = [
                esbuild.build(extensionBuildOptions),
                esbuild.build(copilotBuildOptions),
                ...uiConfigs.map(c => esbuild.build(c))
            ];

            await Promise.all(allConfigs);

            const buildTime = Date.now() - startTime;
            console.log(`Build completed successfully in ${buildTime}ms.`);

            // 输出构建产物列表
            console.log('Built bundles:');
            console.log('  - dist/extension.js');
            console.log('  - dist/copilot.bundle.js');
            uiConfigs.forEach(c => {
                console.log(`  - ${c.outfile}`);
            });

            // 构建完成后复制资源文件
            await copyBuildAssets();

            console.log('Asset copying completed.');
        }
    } catch (error) {
        console.error('Build failed:', error);
        process.exit(1);
    }
}

build();
