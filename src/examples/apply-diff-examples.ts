/*---------------------------------------------------------------------------------------------
 *  Apply Diff 工具使用示例
 *  演示如何使用 apply_diff 工具进行代码修改
 *--------------------------------------------------------------------------------------------*/

import { ApplyDiffTool, ApplyDiffRequest } from '../tools/apply-diff';
import { Logger } from '../utils';

/**
 * Apply Diff 使用示例
 */
export class ApplyDiffExample {
    private applyDiffTool: ApplyDiffTool;

    constructor() {
        this.applyDiffTool = new ApplyDiffTool();
    }

    /**
     * 示例1: 简单的函数修改
     */
    async example1_simpleFunctionModification(): Promise<void> {
        Logger.info('🔧 [示例1] 演示简单函数修改');

        // 创建示例文件内容（这里只是演示，实际使用时文件应该已存在）
        const diffContent = `<<<<<<< SEARCH
:start_line:5
:end_line:7
-------
function add(a, b) {
    return a + b;
}
=======
function add(a, b) {
    // 添加类型检查
    if (typeof a !== 'number' || typeof b !== 'number') {
        throw new Error('参数必须是数字');
    }
    return a + b;
}
>>>>>>> REPLACE`;

        const request: ApplyDiffRequest = {
            path: 'example.js',
            diff: diffContent,
            preview: true // 仅预览，不实际修改
        };

        try {
            const result = await this.applyDiffTool.applyDiff(request);
            Logger.info(`✅ [示例1] ${result.message}`);
            if (result.preview) {
                Logger.info(`📋 [示例1] 预览:\n${result.preview}`);
            }
        } catch (error) {
            Logger.error('❌ [示例1] 执行失败', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 示例2: 多个diff块的应用
     */
    async example2_multipleDiffBlocks(): Promise<void> {
        Logger.info('🔧 [示例2] 演示多个diff块应用');

        const diffContent = `<<<<<<< SEARCH
:start_line:1
:end_line:1
-------
// 旧的注释
=======
// 更新的文件头注释
// 版本: 2.0
>>>>>>> REPLACE

<<<<<<< SEARCH
:start_line:10
:end_line:12
-------
function multiply(a, b) {
    return a * b;
}
=======
function multiply(a, b) {
    // 改进的乘法函数
    return Number(a) * Number(b);
}

function divide(a, b) {
    if (b === 0) {
        throw new Error('除数不能为零');
    }
    return Number(a) / Number(b);
}
>>>>>>> REPLACE`;

        const request: ApplyDiffRequest = {
            path: 'calculator.js',
            diff: diffContent,
            preview: true
        };

        try {
            const result = await this.applyDiffTool.applyDiff(request);
            Logger.info(`✅ [示例2] ${result.message}`);
            Logger.info(`📊 [示例2] 应用了 ${result.blocksApplied} 个diff块`);
        } catch (error) {
            Logger.error('❌ [示例2] 执行失败', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 示例3: TypeScript 文件的修改
     */
    async example3_typeScriptModification(): Promise<void> {
        Logger.info('🔧 [示例3] 演示TypeScript文件修改');

        const diffContent = `<<<<<<< SEARCH
:start_line:3
:end_line:8
-------
interface User {
    name: string;
    age: number;
}

class UserService {
=======
interface User {
    id: string;
    name: string;
    age: number;
    email?: string;
}

interface UserRepository {
    findById(id: string): Promise<User | null>;
    save(user: User): Promise<void>;
}

class UserService {
    constructor(private repository: UserRepository) {}
>>>>>>> REPLACE`;

        const request: ApplyDiffRequest = {
            path: 'user.service.ts',
            diff: diffContent,
            preview: true,
            requireConfirmation: false // 示例中不需要确认
        };

        try {
            const result = await this.applyDiffTool.applyDiff(request);
            Logger.info(`✅ [示例3] ${result.message}`);
        } catch (error) {
            Logger.error('❌ [示例3] 执行失败', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 运行所有示例
     */
    async runAllExamples(): Promise<void> {
        Logger.info('🎯 [Apply Diff 示例] 开始运行所有示例');

        await this.example1_simpleFunctionModification();
        await this.example2_multipleDiffBlocks();
        await this.example3_typeScriptModification();

        Logger.info('🎉 [Apply Diff 示例] 所有示例运行完成');
    }
}

/**
 * Diff 格式说明和最佳实践
 */
export const DIFF_FORMAT_GUIDE = `
# Apply Diff 工具使用指南

## Diff 格式规范

每个 diff block 的格式如下：

\`\`\`diff
<<<<<<< SEARCH
:start_line:行号
:end_line:行号
-------
原始代码内容
=======
新的代码内容
>>>>>>> REPLACE
\`\`\`

## 重要注意事项

1. **行号**: 使用1-based行号，即第一行为1
2. **精确匹配**: SEARCH部分必须与文件中的内容完全匹配（忽略前后空格）
3. **顺序**: 多个diff块会按从后往前的顺序应用，避免行号偏移
4. **备份**: 工具会自动创建文件备份，失败时自动回滚

## 使用技巧

1. **预览模式**: 设置 \`preview: true\` 可以预览修改而不实际应用
2. **用户确认**: 设置 \`requireConfirmation: true\` 会显示确认对话框
3. **相对路径**: 支持相对于工作区的路径和绝对路径
4. **错误处理**: 内容不匹配或文件不存在时会返回详细错误信息

## AI 调用示例

当 AI 助手需要修改代码时，可以这样调用：

\`\`\`javascript
{
  "path": "src/components/Button.tsx",
  "diff": "<<<<<<< SEARCH\\n:start_line:10\\n:end_line:15\\n-------\\n旧代码\\n=======\\n新代码\\n>>>>>>> REPLACE",
  "requireConfirmation": true
}
\`\`\`
`;

// 导出使用指南供文档使用
export { DIFF_FORMAT_GUIDE as default };