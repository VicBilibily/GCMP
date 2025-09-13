/*---------------------------------------------------------------------------------------------
 *  配置管理器测试文件
 *  简单验证配置管理器的基本功能
 *--------------------------------------------------------------------------------------------*/

import { ConfigManager } from '../utils/configManager';
import { Logger } from '../utils';

/**
 * 简单的配置管理器功能测试
 * 这不是正式的单元测试，只是用于验证基本功能
 */
export function testConfigManager(): void {
    Logger.info('=== GCMP 配置管理器测试 ===');

    try {
        // 测试获取默认配置
        const config = ConfigManager.getConfig();
        Logger.info('✓ 获取配置成功:', config);

        // 测试单独获取各项配置
        const temperature = ConfigManager.getTemperature();
        const topP = ConfigManager.getTopP();
        const maxTokens = ConfigManager.getMaxTokens();

        Logger.info('✓ Temperature:', temperature);
        Logger.info('✓ TopP:', topP);
        Logger.info('✓ MaxTokens:', maxTokens);

        // 测试模型最大token计算
        const modelMaxTokens = ConfigManager.getMaxTokensForModel(8192);
        Logger.info('✓ 模型最大Tokens (8192 vs 配置):', modelMaxTokens);

        Logger.info('=== 配置管理器测试完成 ===');

    } catch (error) {
        Logger.error('✗ 配置管理器测试失败:', error);
    }
}

// 如果直接运行此文件，执行测试
if (require.main === module) {
    testConfigManager();
}