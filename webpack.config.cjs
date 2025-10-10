const path = require('path');
const fs = require('fs');

module.exports = {
    target: 'node',
    entry: './src/extension.ts',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2',
        clean: true
    },
    resolve: {
        extensions: ['.ts', '.js'],
        alias: {
            '@': path.resolve(__dirname, 'src')
        }
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: {
                    loader: 'ts-loader',
                    options: {
                        configFile: 'tsconfig.json',
                        transpileOnly: false, // 完整类型检查
                        compilerOptions: {
                            sourceMap: true,
                            declaration: true, // 生成 .d.ts 文件
                            declarationMap: true // 生成 .d.ts.map 文件
                        }
                    }
                }
            }
        ]
    },
    externals: {
        // 排除 VS Code 模块
        vscode: 'commonjs vscode',
        // 排除所有开发依赖和工具
        'webpack': 'commonjs webpack',
        'webpack-cli': 'commonjs webpack-cli',
        'ts-loader': 'commonjs ts-loader',
        '@types/node': 'commonjs @types/node',
        '@types/vscode': 'commonjs @types/vscode',
        'eslint': 'commonjs eslint',
        '@eslint/js': 'commonjs @eslint/js',
        '@stylistic/eslint-plugin': 'commonjs @stylistic/eslint-plugin',
        'typescript-eslint': 'commonjs typescript-eslint',
        'prettier': 'commonjs prettier',
        'rimraf': 'commonjs rimraf',
        '@vscode/vsce': 'commonjs @vscode/vsce',
        'typescript': 'commonjs typescript'
    },
    optimization: {
        minimize: false, // 不压缩，保持可读性
        splitChunks: false, // 不分割代码块
        usedExports: false, // 不移除未使用的导出
        sideEffects: false // 处理无副作用模块
    },
    stats: {
        warnings: false,
        modules: false,
        chunks: false,
        chunkModules: false
    },
    node: {
        __dirname: false,
        __filename: false
    },
    performance: {
        hints: false // 禁用性能提示
    },
    plugins: [
        {
            apply: (compiler) => {
                compiler.hooks.afterEmit.tap('CopyAllFiles', () => {
                    // 复制所有编译后的文件到 dist 目录，保持目录结构
                    const copyDir = (src, dest) => {
                        if (!fs.existsSync(dest)) {
                            fs.mkdirSync(dest, { recursive: true });
                        }

                        const entries = fs.readdirSync(src, { withFileTypes: true });

                        for (const entry of entries) {
                            const srcPath = path.join(src, entry.name);
                            const destPath = path.join(dest, entry.name);

                            if (entry.isDirectory()) {
                                copyDir(srcPath, destPath);
                            } else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts') || entry.name.endsWith('.map')) {
                                fs.copyFileSync(srcPath, destPath);
                            }
                        }
                    };

                    // 复制 src 目录下所有编译后的文件
                    const srcDir = path.resolve(__dirname, 'src');
                    const destDir = path.resolve(__dirname, 'dist');

                    if (fs.existsSync(srcDir)) {
                        copyDir(srcDir, destDir);
                    }
                });
            }
        }
    ]
};
