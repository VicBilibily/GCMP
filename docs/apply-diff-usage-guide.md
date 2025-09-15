# GCMP ApplyDiff 工具使用指南

## 概述

`gcmp_applyDiff` 是一个精准的文件修改工具，支持基于行号的安全编辑，包含备份和回滚机制。

## 何时使用

✅ **适合的场景**：
- 用户明确要求修改特定文件内容
- 需要对代码进行局部调整或bug修复
- 添加新功能或修改现有功能的实现
- 用户提供了具体的修改要求和目标文件

❌ **不适合的场景**：
- 创建新文件（使用其他文件创建工具）
- 大规模重构（建议分步进行）
- 用户没有明确修改意图

## 使用步骤

### 1. 读取文件内容
首先必须读取目标文件的当前内容，确认要修改的部分：

```typescript
// 示例：读取组件文件
const content = await readFile('src/components/Button.vue');
```

### 2. 确定修改位置
找到需要修改的确切行号和内容，确保：
- 行号准确（从1开始计数）
- 原始内容与文件完全匹配
- 包括正确的空格和缩进

### 3. 构造diff格式
使用严格的SEARCH/REPLACE格式：

```diff
<<<<<<< SEARCH
:start_line:起始行号
:end_line:结束行号
-------
要查找和替换的原始内容
=======
替换后的新内容
>>>>>>> REPLACE
```

## 格式示例

### 单行修改
```diff
<<<<<<< SEARCH
:start_line:5
:end_line:5
-------
const version = '1.0.0';
=======
const version = '1.1.0';
>>>>>>> REPLACE
```

### 多行修改
```diff
<<<<<<< SEARCH
:start_line:10
:end_line:12
-------
function oldFunction() {
  return 'old value';
}
=======
function newFunction() {
  return 'new value';
  // 添加了注释
}
>>>>>>> REPLACE
```

### 多块同时修改
```diff
<<<<<<< SEARCH
:start_line:1
:end_line:1
-------
import { Component } from 'vue';
=======
import { Component, Prop } from 'vue';
>>>>>>> REPLACE
<<<<<<< SEARCH
:start_line:15
:end_line:17
-------
export default {
  name: 'MyComponent'
}
=======
export default {
  name: 'MyComponent',
  props: ['data']
}
>>>>>>> REPLACE
```

## 参数说明

### 必需参数

- **path**: 目标文件路径
  - 绝对路径：`"C:\\project\\src\\component.vue"`
  - 相对路径：`"src/components/Button.vue"`

- **diff**: 修改内容，必须遵循SEARCH/REPLACE格式

### 可选参数

- **preview**: 预览模式（默认: false）
  - `true`: 仅显示修改预览，不实际修改文件
  - `false`: 实际执行修改

- **requireConfirmation**: 需要确认（默认: true）
  - `true`: 修改前弹出确认对话框
  - `false`: 直接执行修改（谨慎使用）

## 最佳实践

### 1. 安全第一
```javascript
// 建议：重要文件先预览
{
  "path": "src/critical-component.vue",
  "diff": "...",
  "preview": true,  // 先预览
  "requireConfirmation": true
}
```

### 2. 分步修改
```javascript
// 建议：复杂修改分步进行
// 第一步：修改导入
{
  "path": "src/component.vue",
  "diff": "<<<<<<< SEARCH\n:start_line:1\n:end_line:1\n-------\nimport A from 'a';\n=======\nimport A, { B } from 'a';\n>>>>>>> REPLACE"
}

// 第二步：修改实现
{
  "path": "src/component.vue", 
  "diff": "<<<<<<< SEARCH\n:start_line:10\n:end_line:10\n-------\nconst result = A();\n=======\nconst result = A(B());\n>>>>>>> REPLACE"
}
```

### 3. 验证修改
```javascript
// 修改后验证结果
const updatedContent = await readFile('src/component.vue');
// 检查修改是否正确应用
```

## 常见错误和解决方案

### 1. "未找到有效的diff块"
**原因**: diff格式不正确
**解决**: 检查SEARCH/REPLACE标记是否完整

### 2. "内容不匹配"
**原因**: 原始内容与文件实际内容不符
**解决**: 
- 重新读取文件确认当前内容
- 检查空格、缩进是否一致
- 确认行号是否正确

### 3. "行号范围无效"
**原因**: 指定的行号超出文件范围
**解决**: 确认文件总行数，调整行号

## 调试技巧

### 1. 使用预览模式
```javascript
{
  "preview": true  // 先预览，确认修改正确
}
```

### 2. 检查文件内容
```javascript
// 读取文件内容，确认当前状态
const lines = content.split('\n');
console.log(`第${lineNumber}行: "${lines[lineNumber-1]}"`);
```

### 3. 逐步修改
对于复杂修改，建议分解为多个简单的单行或少量行的修改。

## 示例场景

### 添加新的属性
```diff
<<<<<<< SEARCH
:start_line:8
:end_line:10
-------
const props = {
  title: String
}
=======
const props = {
  title: String,
  description: String
}
>>>>>>> REPLACE
```

### 修复bug
```diff
<<<<<<< SEARCH
:start_line:25
:end_line:25
-------
if (data.length > 0) {
=======
if (data && data.length > 0) {
>>>>>>> REPLACE
```

### 更新版本号
```diff
<<<<<<< SEARCH
:start_line:3
:end_line:3
-------
"version": "1.0.0",
=======
"version": "1.0.1",
>>>>>>> REPLACE
```

通过遵循这些指导原则，可以安全、准确地使用 `gcmp_applyDiff` 工具进行文件修改。