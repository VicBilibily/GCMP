import { ProviderConfig } from '../../types/sharedTypes';
// 统一导出所有模型配置，便于代码 import
import zhipu from './zhipu.json';
import kimi from './kimi.json';
import volcengine from './volcengine.json';
import minimax from './minimax.json';
import iflow from './iflow.json';
import moonshot from './moonshot.json';
import deepseek from './deepseek.json';
import streamlake from './streamlake.json';
import dashscope from './dashscope.json';
import tbox from './tbox.json';
import modelscope from './modelscope.json';
import baidu from './baidu.json';

const providers = {
    zhipu,
    kimi,
    volcengine,
    minimax,
    iflow,
    moonshot,
    deepseek,
    streamlake,
    dashscope,
    tbox,
    modelscope,
    baidu
};

export type ProviderName = keyof typeof providers;

export const configProviders = providers as Record<ProviderName, ProviderConfig>;
