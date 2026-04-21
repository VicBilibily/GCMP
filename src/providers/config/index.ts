import { ProviderConfig } from '../../types/sharedTypes';
// 统一导出所有模型配置，便于代码 import
import zhipu from './zhipu.json';
import volcengine from './volcengine.json';
import minimax from './minimax.json';
import moonshot from './moonshot.json';
import deepseek from './deepseek.json';
import streamlake from './streamlake.json';
import dashscope from './dashscope.json';
import tencent from './tencent.json';
import xiaomimimo from './xiaomimimo.json';
import baidu from './baidu.json';
import gemini from './gemini.json';
import codex from './codex.json';

const providers = {
    zhipu,
    volcengine,
    minimax,
    moonshot,
    deepseek,
    streamlake,
    dashscope,
    tencent,
    xiaomimimo,
    baidu,
    gemini,
    codex
};

export type ProviderName = keyof typeof providers;

export const configProviders = providers as Record<ProviderName, ProviderConfig>;
