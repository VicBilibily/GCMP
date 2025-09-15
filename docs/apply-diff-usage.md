# Apply Diff 工具使用文档

## 概述

Apply Diff 工具是一个强大的代码编辑工具，专为 GitHub Copilot 和其他 AI 助手设计，支持精准的增量代码修改。它基于设计文档中的规范实现，提供了安全可靠的文件编辑功能。

## 主要特性

### ✨ 核心功能
- **精准匹配**: 基于行号和内容的双重验证，确保修改的准确性
- **增量编辑**: 支持多个 diff 块的批量应用，避免全量重写
- **自动备份**: 修改前自动创建备份，失败时自动回滚
- **预览模式**: 支持预览修改内容，确认后再应用
- **错误恢复**: 完善的错误处理和回滚机制

### 🔧 VSCode 集成
- **命令面板**: 提供三个便捷命令
  - `GCMP: 应用 Diff` - 交互式应用 diff
  - `GCMP: 预览 Diff` - 预览 diff 效果
  - `GCMP: 从剪贴板应用 Diff` - 从剪贴板读取 diff 内容
- **diff 预览**: 使用 VSCode 内置 diff 视图显示修改对比
- **用户确认**: 支持修改前的用户确认对话框

### 🤖 AI 工具集成
- **语言模型工具**: 注册为 `gcmp_applyDiff`，可被 AI 助手调用
- **JSON Schema**: 完整的参数验证和文档
- **错误反馈**: 详细的错误信息帮助 AI 理解问题

## Diff 格式规范

### 基本格式

每个 diff 块使用以下格式：

```diff
<<<<<<< SEARCH
:start_line:10
:end_line:12
-------
    // 原始代码
    const result = value * 0.9;
    return result;
=======
    // 新代码
    const result = value * 0.95;
    return result;
>>>>>>> REPLACE
```

### 格式说明

1. **开始标记**: `<<<<<<< SEARCH`
2. **行号标记**: 
   - `:start_line:行号` - 替换的起始行（1-based）
   - `:end_line:行号` - 替换的结束行（1-based）
3. **分隔符**: `-------`
4. **原始内容**: 需要完全匹配的原始代码
5. **分隔符**: `=======`
6. **新内容**: 替换后的代码
7. **结束标记**: `>>>>>>> REPLACE`

### 多个 diff 块

支持在同一个请求中应用多个 diff 块：

```diff
<<<<<<< SEARCH
:start_line:1
:end_line:1
-------
// 旧注释
=======
// 新注释
>>>>>>> REPLACE

<<<<<<< SEARCH
:start_line:10
:end_line:15
-------
function oldFunction() {
    // 旧实现
}
=======
function newFunction() {
    // 新实现
    return improved();
}
>>>>>>> REPLACE
```

## 使用方式

### 1. 命令面板使用

1. 打开命令面板 (`Ctrl+Shift+P`)
2. 输入 "GCMP: 应用 Diff"
3. 选择目标文件（或使用当前编辑器文件）
4. 输入 diff 内容
5. 确认应用修改

### 2. AI 工具调用

AI 助手可以直接调用 `gcmp_applyDiff` 工具：

```json
{
  "path": "src/components/Button.tsx",
  "diff": "<<<<<<< SEARCH\n:start_line:15\n:end_line:20\n-------\n旧代码内容\n=======\n新代码内容\n>>>>>>> REPLACE",
  "requireConfirmation": true
}
```

### 3. 程序化调用

```typescript
import { ApplyDiffTool } from './tools/apply-diff';

const tool = new ApplyDiffTool();
const result = await tool.applyDiff({
    path: 'src/example.ts',
    diff: diffContent,
    preview: false,
    requireConfirmation: true
});

if (result.success) {
    console.log(`成功应用 ${result.blocksApplied} 个diff块`);
} else {
    console.error(`应用失败: ${result.message}`);
}
```

## 参数说明

### ApplyDiffRequest

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `path` | string | ✅ | - | 目标文件路径（绝对路径或相对于工作区） |
| `diff` | string | ✅ | - | diff 内容字符串 |
| `preview` | boolean | ❌ | false | 是否仅预览而不实际应用修改 |
| `requireConfirmation` | boolean | ❌ | false | 是否需要用户确认后再应用 |

### ApplyDiffResponse

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 是否成功 |
| `message` | string | 结果消息 |
| `blocksApplied` | number | 成功应用的 diff 块数量 |
| `preview` | string? | 预览模式下的 diff 内容 |
| `originalContent` | string? | 原始文件内容 |
| `modifiedContent` | string? | 修改后的文件内容 |

## 最佳实践

### ✅ 推荐做法

1. **使用预览模式**: 重要修改前先预览
2. **精确匹配**: 确保 SEARCH 部分与文件内容完全匹配
3. **合理粒度**: 每个 diff 块大小适中，便于理解和调试
4. **保持缩进**: 保持代码原有的缩进和格式
5. **测试验证**: 修改后验证代码功能正确性

### ❌ 避免的问题

1. **行号错误**: 仔细检查行号，避免偏移
2. **内容不匹配**: SEARCH 内容必须与文件完全一致
3. **过大修改**: 避免单个 diff 块过大，影响可读性
4. **格式错误**: 严格按照格式要求，注意标记符号

## 错误处理

### 常见错误及解决方案

1. **"diff块内容不匹配"**
   - 检查 SEARCH 内容是否与文件完全一致
   - 注意空格、制表符等不可见字符
   - 确认行号范围正确

2. **"读取文件失败"**
   - 确认文件路径正确
   - 检查文件是否存在
   - 验证文件权限

3. **"未找到有效的diff块"**
   - 检查 diff 格式是否正确
   - 确认所有必需的标记符号存在

4. **"写入文件失败"**
   - 检查文件写入权限
   - 确认磁盘空间充足
   - 验证文件未被其他程序占用

## 性能和限制

### 性能特性
- **内存效率**: 逐行处理，内存占用较小
- **处理速度**: 快速的字符串匹配和替换
- **并发安全**: 每次操作独立，支持并发调用

### 使用限制
- **文件大小**: 建议单个文件不超过 10MB
- **diff 块数量**: 建议单次不超过 50 个 diff 块
- **行号范围**: 支持 1-999999 行的文件

## 示例场景

### 场景1: 添加错误处理

```diff
<<<<<<< SEARCH
:start_line:15
:end_line:17
-------
function divide(a, b) {
    return a / b;
}
=======
function divide(a, b) {
    if (b === 0) {
        throw new Error('Division by zero');
    }
    return a / b;
}
>>>>>>> REPLACE
```

### 场景2: 重构类方法

```diff
<<<<<<< SEARCH
:start_line:25
:end_line:35
-------
class UserService {
    getUser(id) {
        return this.db.find(id);
    }
    
    saveUser(user) {
        return this.db.save(user);
    }
}
=======
class UserService {
    constructor(database, logger) {
        this.db = database;
        this.logger = logger;
    }
    
    async getUser(id) {
        this.logger.info(`Getting user ${id}`);
        return await this.db.find(id);
    }
    
    async saveUser(user) {
        this.logger.info(`Saving user ${user.id}`);
        return await this.db.save(user);
    }
}
>>>>>>> REPLACE
```

### 场景3: 更新类型定义

```diff
<<<<<<< SEARCH
:start_line:1
:end_line:5
-------
interface User {
    id: string;
    name: string;
}
=======
interface User {
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    updatedAt: Date;
}
>>>>>>> REPLACE
```

## 开发和扩展

如需扩展 Apply Diff 工具功能，可以：

1. **自定义 diff 格式**: 扩展解析器支持更多格式
2. **增强匹配算法**: 添加模糊匹配或智能匹配
3. **集成版本控制**: 与 Git 集成，自动提交修改
4. **批量操作**: 支持多文件批量修改

## 问题反馈

如遇到问题或有改进建议，请：

1. 查看 VSCode 输出窗口的详细日志
2. 检查 diff 格式是否符合规范
3. 确认文件路径和权限设置
4. 提供完整的错误信息和复现步骤

---

**注意**: Apply Diff 工具会修改您的文件，请确保在使用前备份重要代码，或使用版本控制系统管理您的代码。