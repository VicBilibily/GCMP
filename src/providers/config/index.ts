import { ProviderConfig } from '../../types/sharedTypes';
// 统一导出所有模型配置，便于代码 import
import zhipu from './zhipu.json';
import kimi from './kimi.json';
import minimax from './minimax.json';
import iflow from './iflow.json';
import moonshot from './moonshot.json';
import deepseek from './deepseek.json';
import volcengine from './volcengine.json';
import streamlake from './streamlake.json';
import dashscope from './dashscope.json';
import modelscope from './modelscope.json';
import aiping from './aiping.json';
import baidu from './baidu.json';
import tbox from './tbox.json';

const providers = {
    zhipu,
    kimi,
    minimax,
    iflow,
    moonshot,
    deepseek,
    volcengine,
    streamlake,
    dashscope,
    modelscope,
    aiping,
    baidu,
    tbox
};

export type ProviderName = keyof typeof providers;

export const configProviders = providers as Record<ProviderName, ProviderConfig>;
