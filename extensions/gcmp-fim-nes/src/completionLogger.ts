/*---------------------------------------------------------------------------------------------
 *  FIM/NES 补全日志通道（随拆分迁移至本扩展）
 *
 *  沿用主扩展时代的输出通道名 "GitHub Copilot Inline Completion via GCMP"。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const completionLogger = vscode.window.createOutputChannel('GitHub Copilot Inline Completion via GCMP', {
    log: true
});
