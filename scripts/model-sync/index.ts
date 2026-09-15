/** 预置模型手动同步入口：npm run sync:models -- <来源|all> [--check] */
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { parseCommandCodeModels } from './adapters/commandcode';
import { parseHyperModels } from './adapters/hyper';
import { parseOpenAiModelList } from './adapters/openai-model-list';
import { buildExtraEdit, planExtra } from './extra';
import { parseJsonc } from './jsonc';
import { buildTargetEdits, planSource, validateModelDefaults } from './merge';
import type {
    ExtraPlan,
    ModelDefaultsFile,
    ProviderConfigFile,
    RemoteModelMetadata,
    SourcePlan,
    SourcePolicy,
    SourcesFile
} from './types';
import { applyTargetEdit } from './writer';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const configDir = path.join(repoRoot, 'scripts', 'model-sync', 'config');
const providerConfigDir = path.join(repoRoot, 'src', 'providers', 'config');
const FETCH_TIMEOUT_MS = 30_000;

const adapters: Record<SourcePolicy['adapter'], (raw: unknown, label: string) => RemoteModelMetadata[]> = {
    hyper: raw => parseHyperModels(raw),
    'openai-model-list': (raw, label) => parseOpenAiModelList(raw, label),
    commandcode: raw => parseCommandCodeModels(raw)
};

async function main(): Promise<number> {
    const args = process.argv.slice(2);
    const checkOnly = args.includes('--check');
    const selector = args.find(arg => !arg.startsWith('--'));
    if (!selector) {
        console.error('用法：npm run sync:models -- <来源标识|all> [--check]');
        return 1;
    }

    const sources = await readJsonFile<SourcesFile>(path.join(configDir, 'sources.json'));
    const defaults = await readJsonFile<ModelDefaultsFile>(path.join(configDir, 'model-defaults.json'));
    validateSources(sources);
    const defaultsErrors = validateModelDefaults(defaults);
    if (defaultsErrors.length > 0) {
        for (const error of defaultsErrors) {
            console.error(`✗ 默认源配置错误：${error}`);
        }
        return 1;
    }

    const selected = selectSources(sources, selector);
    if (!selected) {
        console.error(`未知来源 "${selector}"，可选：${Object.keys(sources).join('、')}、all`);
        return 1;
    }

    const remoteBySource = new Map<string, RemoteModelMetadata[]>();
    const fetchResults = await Promise.all(
        selected.map(async sourceId => {
            const policy = sources[sourceId];
            try {
                const remote = await fetchModels(sourceId, policy);
                remoteBySource.set(sourceId, remote);
                return { sourceId, count: remote.length };
            } catch (error) {
                return { sourceId, error: error instanceof Error ? error.message : String(error) };
            }
        })
    );
    let failed = false;
    for (const result of fetchResults) {
        if ('error' in result) {
            console.error(`✗ ${result.sourceId}: 拉取失败 - ${result.error}`);
            failed = true;
        } else {
            console.log(`✓ ${result.sourceId}: 远端模型 ${result.count} 个`);
        }
    }
    if (failed) {
        return 1;
    }

    const targetPaths = [...new Set(selected.map(sourceId => sources[sourceId].target))];
    const configTexts = new Map<string, string>();
    const configs = new Map<string, ProviderConfigFile>();
    for (const target of targetPaths) {
        const absolute = path.join(repoRoot, target);
        const text = await readFile(absolute, 'utf8');
        configTexts.set(target, text);
        configs.set(target, JSON.parse(text) as ProviderConfigFile);
    }

    const extraPathBySource = new Map<string, string>();
    const extraTexts = new Map<string, string>();
    const extraConfigs = new Map<string, ProviderConfigFile>();
    for (const sourceId of selected) {
        const policy = sources[sourceId];
        if (!policy.extra || Object.keys(policy.extra).length === 0) {
            continue;
        }
        const providerId = path.basename(policy.target, '.json');
        const extraPath = `website/remote-extra/${providerId}.json`;
        extraPathBySource.set(sourceId, extraPath);
        if (!extraConfigs.has(extraPath)) {
            let text: string;
            try {
                text = (await readFile(path.join(repoRoot, extraPath), 'utf8')).replace(/^﻿/, '');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
                text = '{\n    "models": []\n}\n';
            }
            extraTexts.set(extraPath, text);
            extraConfigs.set(extraPath, JSON.parse(text) as ProviderConfigFile);
        }
    }

    const plans: SourcePlan[] = selected.map(sourceId =>
        planSource({
            sourceId,
            policy: sources[sourceId],
            remote: remoteBySource.get(sourceId) ?? [],
            config: configs.get(sources[sourceId].target)!,
            defaults
        })
    );
    const today = localDate();
    const extraPlans: ExtraPlan[] = selected
        .filter(sourceId => extraPathBySource.has(sourceId))
        .map(sourceId =>
            planExtra({
                sourceId,
                policy: sources[sourceId],
                remote: remoteBySource.get(sourceId) ?? [],
                presetConfig: configs.get(sources[sourceId].target)!,
                extraConfig: extraConfigs.get(extraPathBySource.get(sourceId)!)!,
                defaults,
                today,
                extraPath: extraPathBySource.get(sourceId)!
            })
        );
    const extraPlanBySource = new Map(extraPlans.map(plan => [plan.sourceId, plan]));

    for (const plan of plans) {
        printPlan(plan);
        const extraPlan = extraPlanBySource.get(plan.sourceId);
        if (extraPlan) {
            printExtraPlan(extraPlan);
        }
    }
    const hasErrors = plans.some(plan => plan.errors.length > 0) || extraPlans.some(plan => plan.errors.length > 0);
    const hasPending =
        plans.some(plan => plan.warnings.some(warning => warning.startsWith('待配置：'))) ||
        extraPlans.some(plan => plan.warnings.some(warning => warning.startsWith('待配置：')));
    if (hasErrors) {
        console.error('存在冲突或校验错误，未写入任何文件');
        return 1;
    }
    if (checkOnly) {
        console.log('--check 模式：未写入');
        return hasPending ? 2 : 0;
    }

    const edits = buildTargetEdits(plans, configs);
    for (const [target, edit] of edits) {
        const planned = configTexts.get(target)!;
        const next = applyTargetEdit(planned, edit);
        if (next === planned) {
            console.log(`${target}: 无变更`);
            continue;
        }
        const absolute = path.join(repoRoot, target);
        const current = await readFile(absolute, 'utf8');
        if (current !== planned) {
            console.error(`✗ ${target}: 文件在同步期间被修改，已跳过写入`);
            failed = true;
            continue;
        }
        await writeAtomically(absolute, next);
        console.log(`✓ 已更新 ${target}`);
    }

    const extraPaths = [...new Set(extraPlans.map(plan => plan.extraPath))];
    for (const extraPath of extraPaths) {
        let next = extraTexts.get(extraPath)!;
        for (const plan of extraPlans.filter(item => item.extraPath === extraPath)) {
            next = applyTargetEdit(next, buildExtraEdit(plan, extraConfigs.get(extraPath)!));
        }
        const planned = extraTexts.get(extraPath)!;
        if (next === planned) {
            console.log(`${extraPath}: 无变更`);
            continue;
        }
        const absolute = path.join(repoRoot, extraPath);
        let current: string;
        try {
            current = (await readFile(absolute, 'utf8')).replace(/^﻿/, '');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            current = '{\n    "models": []\n}\n';
        }
        if (current !== planned) {
            console.error(`✗ ${extraPath}: 文件在同步期间被修改，已跳过写入`);
            failed = true;
            continue;
        }
        await writeAtomically(absolute, next);
        console.log(`✓ 已更新 ${extraPath}`);
    }
    if (failed) {
        return 1;
    }
    console.log('请审查 git diff 后单独提交');
    return hasPending ? 2 : 0;
}

function selectSources(sources: SourcesFile, selector: string): string[] | undefined {
    if (selector === 'all') {
        return Object.keys(sources);
    }
    if (!Object.prototype.hasOwnProperty.call(sources, selector)) {
        return undefined;
    }
    // 共享目标文件的来源必须一起计划，避免半份更新
    const target = sources[selector].target;
    return Object.keys(sources).filter(sourceId => sources[sourceId].target === target);
}

/** 标准代理环境变量之外，兼容 npm run 注入的 npm_config_proxy 配置；未配置时直连。 */
function resolveProxyDispatcher(): InstanceType<typeof ProxyAgent> | EnvHttpProxyAgent | undefined {
    const npmProxy = process.env.npm_config_https_proxy ?? process.env.npm_config_proxy;
    if (npmProxy) {
        return new ProxyAgent(new URL(npmProxy).origin);
    }
    if (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy) {
        return new EnvHttpProxyAgent();
    }
    return undefined;
}

async function fetchModels(sourceId: string, policy: SourcePolicy): Promise<RemoteModelMetadata[]> {
    const response = await undiciFetch(policy.endpoint, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
        dispatcher: resolveProxyDispatcher()
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const raw: unknown = await response.json();
    return adapters[policy.adapter](raw, sourceId);
}

function validateSources(sources: SourcesFile): void {
    for (const [sourceId, policy] of Object.entries(sources)) {
        if (!adapters[policy.adapter]) {
            throw new Error(`${sourceId}: 未知适配器 "${policy.adapter}"`);
        }
        if (!/^https:\/\//.test(policy.endpoint)) {
            throw new Error(`${sourceId}: endpoint 必须是 HTTPS 地址`);
        }
        const targetAbsolute = path.resolve(repoRoot, policy.target);
        if (!targetAbsolute.startsWith(providerConfigDir + path.sep)) {
            throw new Error(`${sourceId}: target 必须位于 src/providers/config 内`);
        }
        if (policy.nameSuffix && policy.nameSuffix !== policy.nameSuffix.trim()) {
            throw new Error(`${sourceId}: nameSuffix 不允许首尾空白，拼接时自动添加空格`);
        }
        for (const prefix of policy.excludedModelIdPrefixes ?? []) {
            if (typeof prefix !== 'string' || prefix.length <= Number(prefix.endsWith('$'))) {
                throw new Error(`${sourceId}: excludedModelIdPrefixes 必须是非空字符串`);
            }
        }
        for (const suffix of policy.excludedModelIdSuffixes ?? []) {
            if (typeof suffix !== 'string' || suffix.length === 0) {
                throw new Error(`${sourceId}: excludedModelIdSuffixes 必须是非空字符串`);
            }
        }
        for (const rule of policy.modelRules ?? []) {
            const prefixes = [rule.idPrefix, ...(rule.idPrefixes ?? [])].filter(
                (prefix): prefix is string => typeof prefix === 'string'
            );
            if (prefixes.length === 0 || prefixes.some(prefix => prefix.length === 0)) {
                throw new Error(`${sourceId}: modelRules 必须提供非空 idPrefix 或 idPrefixes`);
            }
        }
        for (const [remoteId, entry] of Object.entries(policy.models ?? {})) {
            if (entry.ref !== undefined) {
                const slash = entry.ref.indexOf('/');
                if (slash <= 0 || slash === entry.ref.length - 1) {
                    throw new Error(`${sourceId}/${remoteId}: ref 必须是 "作者/模型" 格式`);
                }
            }
        }
        for (const [remoteId, registration] of Object.entries(policy.extra ?? {})) {
            if (registration.reason !== 'sunset' && registration.reason !== 'online-only') {
                throw new Error(`${sourceId}/${remoteId}: extra reason 必须是 sunset 或 online-only`);
            }
            if (registration.reason === 'sunset' && !isValidDate(registration.sunsetAt)) {
                throw new Error(`${sourceId}/${remoteId}: sunset 登记必须提供 YYYY-MM-DD 格式的 sunsetAt`);
            }
            if (registration.reason === 'online-only' && registration.sunsetAt !== undefined) {
                throw new Error(`${sourceId}/${remoteId}: online-only 登记不允许 sunsetAt`);
            }
        }
    }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
    return parseJsonc<T>(await readFile(filePath, 'utf8'));
}

function printPlan(plan: SourcePlan): void {
    console.log(`\n=== ${plan.sourceId} → ${plan.targetPath} ===`);
    const adds = plan.entries.filter(entry => entry.action === 'add');
    const updates = plan.entries.filter(entry => entry.action === 'update');
    const removals = plan.entries.filter(entry => entry.action === 'remove');
    for (const entry of adds) {
        console.log(`+ 新增 ${entry.localId}${entry.localId === entry.remoteId ? '' : `（远端 ${entry.remoteId}）`}`);
    }
    for (const entry of updates) {
        console.log(`~ 更新 ${entry.localId}`);
        for (const change of entry.changes ?? []) {
            console.log(
                `    ${change.field}: ${formatValue(change.from)} → ${formatValue(change.to)}（${change.origin}）`
            );
        }
    }
    for (const entry of removals) {
        console.log(`- 移除 ${entry.localId}（${entry.reason ?? ''}）`);
    }
    for (const warning of plan.warnings) {
        console.log(`! ${warning}`);
    }
    for (const error of plan.errors) {
        console.log(`✗ ${error}`);
    }
    if (adds.length + updates.length + removals.length === 0) {
        console.log('（无模型变更）');
    }
}

function printExtraPlan(plan: ExtraPlan): void {
    console.log(`=== extra: ${plan.sourceId} → ${plan.extraPath} ===`);
    const adds = plan.entries.filter(entry => entry.action === 'add');
    const updates = plan.entries.filter(entry => entry.action === 'update');
    for (const entry of adds) {
        console.log(`+ 新增 ${entry.localId}${entry.localId === entry.remoteId ? '' : `（远端 ${entry.remoteId}）`}`);
    }
    for (const entry of updates) {
        console.log(`~ 更新 ${entry.localId}`);
    }
    for (const warning of plan.warnings) {
        console.log(`! ${warning}`);
    }
    for (const error of plan.errors) {
        console.log(`✗ ${error}`);
    }
    if (adds.length + updates.length === 0) {
        console.log('（无 extra 变更）');
    }
}

function formatValue(value: unknown): string {
    if (value === undefined) {
        return '(删除)';
    }
    return JSON.stringify(value);
}

function localDate(): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
}

function isValidDate(value: string | undefined): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) {
        return false;
    }
    const date = new Date(`${value}T00:00:00Z`);
    return date.toISOString().slice(0, 10) === value;
}

/** 同目录临时文件 + rename 替换，对 Windows 瞬态占用做有界重试。 */
async function writeAtomically(target: string, content: string): Promise<void> {
    const tmp = `${target}.sync-${process.pid}.tmp`;
    await writeFile(tmp, content, 'utf8');
    for (let attempt = 0; ; attempt++) {
        try {
            await rename(tmp, target);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!code || !['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(code) || attempt >= 5) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
        }
    }
}

main()
    .then(code => {
        process.exitCode = code;
    })
    .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
