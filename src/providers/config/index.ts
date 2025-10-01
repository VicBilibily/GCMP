// 统一导出所有模型配置，便于代码 import
import zhipu from './zhipu.json';
import iflow from './iflow.json';
import moonshot from './moonshot.json';
import deepseek from './deepseek.json';

export const configProviders = {
    zhipu,
    iflow,
    moonshot,
    deepseek,
};

export type ProviderName = keyof typeof configProviders;
