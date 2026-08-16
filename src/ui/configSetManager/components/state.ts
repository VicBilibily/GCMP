/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - 全局状态与基础工具
 *  所有组件模块的根基：state 单例 + el/t/postToVSCode/ensureSelection 等
 *--------------------------------------------------------------------------------------------*/

import type {
    ProviderOption,
    ProviderState,
    CliProviderOption,
    GistSyncState,
    RemoteSlotSnapshot,
    UploadSlotSnapshot,
    ActiveSlotSnapshot,
    RemoteManageSlotSnapshot,
    ConfigUsageState,
    WebViewMessage
} from '../types';

// ============= DOM 工具 =============

export function postToVSCode(message: WebViewMessage): void {
    window.vscode.postMessage(message);
}

export function t(en: string, zh: string, ...args: unknown[]): string {
    const lang = (document.documentElement.lang || navigator.language || '').toLowerCase();
    let text = lang === 'zh-cn' || lang === 'zh' || lang.startsWith('zh-') ? zh : en;
    args.forEach((arg, i) => {
        // split/join 替换：避免 replace 把 $&/$' 等当替换模式，且替换全部占位符
        text = text.split(`{${i}}`).join(String(arg));
    });
    return text;
}

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string = '',
    text?: string
): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) {
        e.className = className;
    }
    if (text !== undefined) {
        e.textContent = text;
    }
    return e;
}

// ============= 全局状态 =============

export interface State {
    providers: ProviderOption[];
    states: ProviderState[];
    cliProviders: CliProviderOption[];
    configUsages: Record<string, ConfigUsageState>;
    /** Gist 同步状态（init 后由后端推送） */
    syncState: GistSyncState | null;
    /** 右上角 Gist 菜单是否展开 */
    gistMenuOpen: boolean;
    busy: boolean;
    restoreSnapshots: RemoteSlotSnapshot[] | null;
    /** 上传预检快照（待选择上传的配置） */
    uploadSnapshots: UploadSlotSnapshot[] | null;
    /** 上传预检时远端是否可读（不可读时仅允许全选覆盖上传） */
    uploadRemoteReadable: boolean;
    /** 已激活 Key 快照（统一管理对话框用） */
    activeSnapshots: ActiveSlotSnapshot[] | null;
    /** 远端配置快照（远端管理对话框用，勾选保留、未选删除） */
    remoteSnapshots: RemoteManageSlotSnapshot[] | null;
    /** 当前选中的侧栏项（provider 名或 cli:provider 名） */
    selectedProvider: string | null;
    /** 当前展开新增表单的槽位（slot 名），null = 无展开 */
    addFormSlot: string | null;
    /** 当前展开编辑表单的配置 ID（slot:id），null = 无展开 */
    editFormKey: string | null;
}

export const state: State = {
    providers: [],
    states: [],
    cliProviders: [],
    configUsages: {},
    syncState: null,
    gistMenuOpen: false,
    busy: false,
    restoreSnapshots: null,
    uploadSnapshots: null,
    uploadRemoteReadable: true,
    activeSnapshots: null,
    remoteSnapshots: null,
    selectedProvider: null,
    addFormSlot: null,
    editFormKey: null
};

// ============= 状态查询工具 =============

export function findProviderState(provider: string): ProviderState | undefined {
    return state.states.find(s => s.provider === provider);
}

export function findOption(provider: string): ProviderOption | undefined {
    return state.providers.find(p => p.provider === provider);
}

export function getConfigUsageKey(slot: string, id: string): string {
    return `${slot}:${id}`;
}

export function getConfigMetricType(slot: string, metricType?: 'usage' | 'balance'): 'usage' | 'balance' {
    if (metricType) {
        return metricType;
    }
    return slot === 'moonshot' || slot === 'deepseek' ? 'balance' : 'usage';
}

export function ensureSelection(): void {
    // 常规提供商：在 states 中存在即可保留
    if (
        state.selectedProvider &&
        !state.selectedProvider.startsWith('cli:') &&
        state.states.some(s => s.provider === state.selectedProvider)
    ) {
        return;
    }
    // CLI 提供商：在 cliProviders 中存在即可保留
    if (
        state.selectedProvider?.startsWith('cli:') &&
        state.cliProviders.some(c => `cli:${c.provider}` === state.selectedProvider)
    ) {
        return;
    }
    const withRows = state.states.find(s => s.slots.some(slot => slot.rows.length > 0));
    state.selectedProvider = (withRows ?? state.states[0])?.provider ?? null;
}

export function requestUsageForSelection(): void {
    const provider = state.selectedProvider;
    if (!provider) {
        return;
    }
    // CLI 提供商：按需查询余量（切换进入时触发，不预加载）
    if (provider.startsWith('cli:')) {
        postToVSCode({ command: 'refreshCliUsage', provider: provider.slice(4) });
        return;
    }
    postToVSCode({ command: 'loadProviderUsage', provider });
}

// ============= 消息提示 =============

export function showMessage(kind: 'info' | 'warning' | 'error' | '', text?: string): void {
    const bar = document.querySelector('.csm-message-bar');
    if (!bar) {
        return;
    }
    if (!text) {
        bar.innerHTML = '';
        return;
    }
    bar.innerHTML = '';
    bar.appendChild(el('div', `csm-message csm-message-${kind === '' ? 'info' : kind}`, text));
}

export function clearMessage(): void {
    const bar = document.querySelector('.csm-message-bar');
    if (bar) {
        bar.innerHTML = '';
    }
}
