/*---------------------------------------------------------------------------------------------
 *  工具管理器
 *  负责为语言模型请求动态添加工具支持
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { Tool, ToolChoice } from './types';

/**
 * 请求体接口（用于工具管理）
 */
interface ToolRequestBody {
    tools?: Tool[];
    tool_choice?: string | ToolChoice;
}

/**
 * 工具管理器类
 * 负责管理和添加各种工具到语言模型请求中
 */
export class ToolManager {

    /**
     * 检测是否为编辑模式
     * 基于是否存在edit_files工具来判断
     */
    static isEditMode(options: vscode.ProvideLanguageModelChatResponseOptions): boolean {
        const hasEditFiles = options.tools?.some(tool => tool.name === 'edit_files');
        return hasEditFiles || false;
    }

    /**
     * 为请求添加所有可用的工具
     */
    static addToolsToRequest(
        requestBody: ToolRequestBody,
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        provider: string
    ): void {
        if (!model.capabilities?.toolCalling) {
            return;
        }
        // 搜索工具：如果启用，在所有情况下都可以调用
        this.addSearchTools(requestBody, model, provider);

        // 检测编辑模式
        const isEditMode = this.isEditMode(options);
        // Apply Diff工具：只在编辑模式下添加
        if (isEditMode) {
            this.addApplyDiffTool(requestBody, model);
        }

    }

    /**
     * 添加Apply Diff工具
     */
    private static addApplyDiffTool(
        requestBody: ToolRequestBody,
        _model: vscode.LanguageModelChatInformation
    ): void {
        if (!ConfigManager.getApplyDiffEnabled()) {
            return;
        }

        const applyDiffTool: Tool = {
            type: 'function',
            function: {
                name: 'gcmp_applyDiff',
                description: '**精准文件修改工具** - 基于 VS Code 深度集成的文件修改工具，具有聊天修改历史追踪、智能内容匹配和增强预览功能。\n\n**主要优势**：\n- **VS Code 原生集成**：完美融入编辑器，支持撤销/重做\n- **聊天历史追踪**：自动记录到聊天修改历史\n- **智能匹配**：支持精确匹配和模糊匹配\n- **实时预览**：使用 VS Code 内置 diff 查看器\n- **批量操作**：高效处理多个修改块\n- **安全机制**：增强的错误处理和恢复\n\n**何时使用**：\n- 需要对代码进行精确修改和重构\n- 要求修改历史可追踪和可撤销\n- 处理复杂的多块文件修改\n- 需要智能内容匹配的场景\n\n**格式要求**：使用标准的 SEARCH/REPLACE 格式，支持行号指定和智能匹配。',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: '目标文件路径（绝对路径或相对于工作区的路径）。支持智能路径解析和自动工作区检测。'
                        },
                        diff: {
                            type: 'string',
                            description: 'diff修改内容，使用增强的SEARCH/REPLACE格式：\n\n基本格式：\n<<<<<<< SEARCH\n:start_line:起始行号\n:end_line:结束行号\n-------\n要查找的原始内容（支持智能匹配）\n=======\n替换后的新内容\n>>>>>>> REPLACE\n\n增强特性：\n- **智能匹配**：自动处理空格、缩进差异\n- **置信度评估**：自动评估匹配可靠性\n- **语言检测**：自动识别编程语言\n- **多块支持**：单个 diff 中支持多个 SEARCH/REPLACE 块\n- **插入操作**：支持在文件开头或指定位置插入内容\n\n重要提示：\n- 行号从1开始，支持智能行号调整\n- 原始内容支持模糊匹配和精确匹配\n- 自动语法验证和错误恢复'
                        },
                        batch: {
                            type: 'boolean',
                            description: '批量模式：优化多文件或大量修改的处理性能。适用于重构或批量更新场景。',
                            default: false
                        }
                    },
                    required: ['path', 'diff']
                }
            }
        };

        if (!requestBody.tools) {
            requestBody.tools = [];
        }
        requestBody.tools.push(applyDiffTool);

        if (!requestBody.tool_choice) {
            requestBody.tool_choice = 'auto';
        }
    }

    /**
     * 添加搜索工具（在所有情况下都可以调用）
     */
    private static addSearchTools(
        requestBody: ToolRequestBody,
        model: vscode.LanguageModelChatInformation,
        provider: string
    ): void {
        let addedSearchTools = 0;

        // 为MoonshotAI添加联网搜索工具支持
        if (provider === 'moonshot' && ConfigManager.getMoonshotWebSearchEnabled()) {
            this.addMoonshotWebSearchTool(requestBody, model);
            addedSearchTools++;
        }

        // 未来可以在这里添加其他提供商的搜索工具
        // 例如：
        // if (provider === 'zhipu') {
        //     this.addZhipuSearchTools(requestBody, model);
        //     addedSearchTools++;
        // }

        if (addedSearchTools > 0) {
            Logger.debug(`🔍 ${model.name} 已添加 ${addedSearchTools} 个搜索工具`);
        } else {
            Logger.debug(`🔍 ${model.name} 未添加任何搜索工具`);
        }
    }

    /**
     * 添加Moonshot联网搜索工具
     */
    private static addMoonshotWebSearchTool(
        requestBody: ToolRequestBody,
        model: vscode.LanguageModelChatInformation
    ): void {
        const webSearchTool: Tool = {
            type: 'builtin_function',
            function: {
                name: '$web_search'
            }
        };

        if (!requestBody.tools) {
            requestBody.tools = [];
        }
        requestBody.tools.push(webSearchTool);

        if (!requestBody.tool_choice) {
            requestBody.tool_choice = 'auto';
        }

        Logger.debug(`🚀 ${model.name} 已启用Kimi内置联网搜索工具 $web_search`);
    }

    /**
     * 获取工具统计信息
     */
    static getToolsStats(tools?: Tool[]): { count: number; types: string[] } {
        if (!tools || tools.length === 0) {
            return { count: 0, types: [] };
        }

        const types = tools.map(tool => {
            if (tool.type === 'function') {
                return tool.function.name;
            } else if (tool.type === 'builtin_function') {
                return tool.function.name;
            }
            return tool.type;
        });

        return { count: tools.length, types };
    }

    /**
     * 验证工具配置
     */
    static validateToolsConfiguration(): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];

        try {
            // 验证Apply Diff工具配置
            const applyDiffEnabled = ConfigManager.getApplyDiffEnabled();
            Logger.debug(`Apply Diff工具配置状态: ${applyDiffEnabled ? '启用' : '禁用'}`);

            // 验证Moonshot联网搜索配置
            const moonshotWebSearchEnabled = ConfigManager.getMoonshotWebSearchEnabled();
            Logger.debug(`Moonshot联网搜索配置状态: ${moonshotWebSearchEnabled ? '启用' : '禁用'}`);

            // 可以添加更多验证逻辑

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            errors.push(`工具配置验证失败: ${errorMessage}`);
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }
}