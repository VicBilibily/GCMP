const fs = require('fs');
const path = require('path');

// 需要复制的运行时依赖
const dependencies = [
    '@microsoft/tiktokenizer',
    '@modelcontextprotocol/sdk',
    'openai'
];

const srcDir = path.resolve(__dirname, '../node_modules');
const destDir = path.resolve(__dirname, '../dist/node_modules');

function copyDirectory(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDirectory(srcPath, destPath);
        } else {
            // 只复制 .js 文件和必要的类型文件
            if (entry.name.endsWith('.js') || 
                entry.name.endsWith('.d.ts') || 
                entry.name.endsWith('.json') ||
                entry.name.endsWith('.md')) {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }
}

console.log('复制运行时依赖到 dist/node_modules...');

for (const dep of dependencies) {
    const depSrcPath = path.join(srcDir, dep);
    const depDestPath = path.join(destDir, dep);

    if (fs.existsSync(depSrcPath)) {
        console.log(`复制 ${dep}...`);
        copyDirectory(depSrcPath, depDestPath);
    } else {
        console.warn(`警告: 依赖 ${dep} 不存在`);
    }
}

console.log('依赖复制完成！');