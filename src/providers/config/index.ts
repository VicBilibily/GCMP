import { ProviderConfig } from '../../types/sharedTypes';
// 统一导出所有模型配置，便于代码 import
import zhipu from './zhipu.json';
import iflow from './iflow.json';
import moonshot from './moonshot.json';
import deepseek from './deepseek.json';
import volcengine from './volcengine.json';
import dashscope from './dashscope.json';
import minimax from './minimax.json';
import siliconflow from './siliconflow.json';
import infini from './infini.json';
import coreshub from './coreshub.json';
import tencentcloud from './tencentcloud.json';
import huaweicloud from './huaweicloud.json';
import jdcloud from './jdcloud.json';
import qiniu from './qiniu.json';
import ucloud from './ucloud.json';
import paratera from './paratera.json';
import ppio from './ppio.json';
import lanyun from './lanyun.json';
import sophnet from './sophnet.json';
import baidu from './baidu.json';
import modelscope from './modelscope.json';

const providers = {
    zhipu,
    iflow,
    moonshot,
    deepseek,
    volcengine,
    dashscope,
    minimax,
    modelscope,
    siliconflow,
    infini,
    coreshub,
    tencentcloud,
    huaweicloud,
    jdcloud,
    qiniu,
    ucloud,
    paratera,
    ppio,
    lanyun,
    sophnet,
    baidu
};

export type ProviderName = keyof typeof providers;

export const configProviders = providers as Record<ProviderName, ProviderConfig>;
