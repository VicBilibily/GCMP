// 统一导出所有模型配置，便于代码 import
import zhipu from './zhipu.json';
import iflow from './iflow.json';
import moonshot from './moonshot.json';
import deepseek from './deepseek.json';
import minimax from './minimax.json';
import huaweicloud from './huaweicloud.json';
import tencentcloud from './tencentcloud.json';
import jdcloud from './jdcloud.json';
import volcengine from './volcengine.json';
import ucloud from './ucloud.json';
import coreshub from './coreshub.json';
import paratera from './paratera.json';
import lanyun from './lanyun.json';
import qiniu from './qiniu.json';
import sophnet from './sophnet.json';

export const configProviders = {
    zhipu,
    iflow,
    moonshot,
    deepseek,
    minimax,
    huaweicloud,
    tencentcloud,
    jdcloud,
    volcengine,
    ucloud,
    coreshub,
    paratera,
    lanyun,
    qiniu,
    sophnet
};

export type ProviderName = keyof typeof configProviders;
