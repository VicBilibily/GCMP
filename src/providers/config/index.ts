// 统一导出所有模型配置，便于代码 import
import zhipu from './zhipu.json';
import iflow from './iflow.json';
import moonshot from './moonshot.json';
import deepseek from './deepseek.json';
import minimax from './minimax.json';
import sensecore from './sensecore.json';

export const configProviders = {
    zhipu,
    iflow,
    moonshot,
    deepseek,
    minimax,
    sensecore
};

export type ProviderName = keyof typeof configProviders;
