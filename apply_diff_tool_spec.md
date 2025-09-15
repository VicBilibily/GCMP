# VSCode Copilot 可用的 apply_diff Tool 设计与实现方案

## 目标

实现一个可被 VSCode Copilot（或其他 AI agent）自动调用的 apply_diff 工具，实现对现有文件的“增量精准编辑”，而非全量重写，提升效率与可靠性。

---

## 1. 输入/输出定义

- **输入参数**
  - `path`：目标文件路径（string）
  - `diff`：diff 内容（字符串，支持多块，需带行号，格式见下）

- **输出**
  - 应用 diff 后的文件内容
  - 执行结果（成功/失败，及错误信息）
  - 可选：应用前后的 diff 视图供用户审核

---

## 2. Diff 格式规范（建议）

每个 diff block 形如：

```diff
<<<<<<< SEARCH
:start_line:10
:end_line:12
-------
    // Old code
    const result = value * 0.9;
    return result;
=======
    // New code
    const result = value * 0.95;
    return result;
>>>>>>> REPLACE
```

- `:start_line:`、`:end_line:` 标明需替换的文件原始行范围（1-based）
- `SEARCH` 块为原内容，`REPLACE` 为新内容

支持多个 diff block 连续应用

---

## 3. 实现流程

1. **解析 diff**
    - 逐块提取 start/end 行号、SEARCH/REPLACE 内容

2. **读取并备份目标文件**

3. **依次处理每个 diff block**
    - 定位目标代码（行号+内容精准匹配，必要时可支持模糊匹配）
    - 替换为新内容，保留原缩进/格式

4. **写回文件，保存修改**

5. **可选：生成 diff 预览**
    - 利用 VSCode API 弹出 diff 视图，供用户审核/确认

6. **错误与回滚机制**
    - 匹配失败/写入失败/用户拒绝时，回滚到原始文件

---

## 4. VSCode 插件对接建议

- 实现为 command，如 `extension.applyDiff`
- 支持通过消息（如 LSP、自定义协议）被 Copilot/AI Agent 调用
- 可暴露 REST/IPC/消息队列等接口，便于后续自动化扩展

---

## 5. 用户体验建议

- 默认启用“通过 diff 编辑”，实现快速增量修改
- 应用前弹出 diff 审核窗口，允许手动编辑/确认
- 提供 undo/redo 支持

---

## 6. 伪代码参考

```typescript
interface DiffBlock {
  startLine: number;
  endLine: number;
  searchLines: string[];
  replaceLines: string[];
}

function applyDiff(filePath: string, diffBlocks: DiffBlock[]) {
  let lines = readFile(filePath);
  for (const block of diffBlocks) {
    const section = lines.slice(block.startLine - 1, block.endLine);
    if (!isEqual(section, block.searchLines)) {
      throw new Error('SEARCH not match file content');
    }
    lines.splice(block.startLine - 1, block.endLine - block.startLine + 1, ...block.replaceLines);
  }
  writeFile(filePath, lines);
}
```

---

## 7. 参考资料

- [Kilo Code apply_diff 官方文档](https://github.com/Kilo-Org/kilocode/blob/main/apps/kilocode-docs/docs/features/tools/apply-diff.md)
- [VSCode Extension API](https://code.visualstudio.com/api/references/vscode-api)
- [diff-match-patch 算法](https://github.com/google/diff-match-patch)（可选，用于模糊/智能匹配）

---

## 8. 后续扩展

- 支持多种 diff 策略（如模糊定位、token 匹配等）
- 支持多文件批量修改
- 与 AI agent 深度集成，自动生成与应用 diff

---