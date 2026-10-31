/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - 详情区渲染
 *  renderDetail / renderCliDetail / renderCliAccountCard / renderSlotSection
 *--------------------------------------------------------------------------------------------*/

import {
    isCredentialExpiryDateExpired,
    type ProviderState,
    type SlotState,
    type ProviderOption,
    type CliOAuthCredentialOption,
    type CliProviderOption
} from '../types';
import { el, t, state, findProviderState, findOption, clearMessage, postToVSCode } from './state';
import { renderCliUsage } from './usage';
import { renderSlotCards, renderAddForm } from './cards';

// ============= 主详情 =============

export function renderDetail(): HTMLElement {
    const detail = el('section', 'csm-detail');

    // CLI 认证提供商详情
    if (state.selectedProvider?.startsWith('cli:')) {
        return renderCliDetail(detail, state.selectedProvider.slice(4));
    }

    const pst = findProviderState(state.selectedProvider ?? '');
    if (!pst) {
        detail.appendChild(el('div', 'csm-empty-detail', t('No provider available', '暂无可用提供商')));
        return detail;
    }
    const opt = findOption(pst.provider);

    // 提供商标题
    const head = el('div', 'csm-detail-head');
    const titleWrap = el('div', 'csm-detail-title');
    titleWrap.appendChild(el('h3', '', pst.displayName));
    const slotCount = pst.slots.length;
    titleWrap.appendChild(el('span', 'csm-detail-count', String(slotCount)));
    head.appendChild(titleWrap);
    detail.appendChild(head);

    // 每个槽位一个分区
    for (const slotState of pst.slots) {
        detail.appendChild(renderSlotSection(pst, slotState, opt));
    }

    return detail;
}

// ============= CLI 详情 =============

export function renderCliDetail(detail: HTMLElement, provider: string): HTMLElement {
    const cli = state.cliProviders.find(c => c.provider === provider);
    if (!cli) {
        detail.appendChild(el('div', 'csm-empty-detail', t('No provider available', '暂无可用提供商')));
        return detail;
    }

    // 标题区：提供商标题
    const head = el('div', 'csm-detail-head');
    const titleWrap = el('div', 'csm-detail-title');
    titleWrap.appendChild(el('h3', '', cli.displayName));
    head.appendChild(titleWrap);
    detail.appendChild(head);

    const guide = el('div', 'csm-config-card-note csm-cli-guide');
    guide.appendChild(
        el(
            'p',
            'csm-cli-desc',
            t(
                'Sign in to another CLI account, then import it as a named OAuth account. Saved accounts stay separate; checking quota does not change the active account.',
                '如需添加账号，先在 CLI 中登录该账号，再导入为独立 OAuth 账号。已保存账号互不覆盖；查询额度不会切换当前活跃账号。'
            )
        )
    );
    const guideActions = el('div', 'csm-config-card-footer');
    const terminalBtn = el('button', 'csm-btn csm-btn-sm', t('Open CLI Terminal', '打开 CLI 终端'));
    terminalBtn.type = 'button';
    terminalBtn.disabled = state.busy || !cli.isCliInstalled;
    terminalBtn.addEventListener('click', () => {
        postToVSCode({ command: 'openCliTerminal', provider: cli.provider });
    });
    guideActions.appendChild(terminalBtn);

    const importBtn = el('button', 'csm-btn csm-btn-primary csm-btn-sm', t('Import CLI Account', '导入 CLI 账号'));
    importBtn.type = 'button';
    importBtn.disabled = state.busy;
    importBtn.addEventListener('click', () => {
        state.busy = true;
        render();
        postToVSCode({ command: 'importCliCredential', provider: cli.provider });
    });
    guideActions.appendChild(importBtn);

    const folderBtn = el('button', 'csm-btn csm-btn-sm', t('Open OAuth Folder', '打开 OAuth 文件夹'));
    folderBtn.type = 'button';
    folderBtn.addEventListener('click', () => {
        postToVSCode({ command: 'openOAuthFolder', provider: cli.provider });
    });
    guideActions.appendChild(folderBtn);
    guide.appendChild(guideActions);
    detail.appendChild(guide);

    if (cli.oauthCredentials.length > 0) {
        detail.appendChild(renderCliRoutingControls(cli));
    }

    // 每个命名 OAuth 账号独立展示；无命名账号时显示 CLI 默认凭证。
    const list = el('div', 'csm-card-list');
    if (cli.oauthCredentials.length > 0) {
        for (const account of cli.oauthCredentials) {
            list.appendChild(renderCliAccountCard(cli, account));
        }
    } else {
        list.appendChild(renderCliAccountCard(cli));
    }
    detail.appendChild(list);

    return detail;
}

function renderCliRoutingControls(cli: CliProviderOption): HTMLElement {
    const section = el('div', 'csm-cli-routing');
    section.appendChild(el('div', 'csm-config-meta-label', t('Account routing', '账号路由')));
    const tabs = el('div', 'csm-switch-tabs');
    const enabledCount = cli.oauthCredentials.filter(
        account => account.hasAccessToken && (account.balanceWeight ?? 1) > 0
    ).length;
    const modes: Array<{ mode: CliProviderOption['switchMode']; label: string; title: string }> = [
        {
            mode: 'off',
            label: t('Off', '关闭'),
            title: t('Use the active OAuth account.', '仅使用当前活跃 OAuth 账号。')
        },
        {
            mode: 'failover',
            label: t('Failover', '故障转移'),
            title: t(
                'On account authorization or quota rejection, activate the next eligible account and retry.',
                '账号授权被拒绝或明确额度耗尽时，切换到下一个可用账号并重试。'
            )
        },
        {
            mode: 'balance',
            label: t('Balance', '负载均衡'),
            title: t(
                'Assign accounts by session and weight. Account rejection moves only that session.',
                '按会话和权重分配账号；账号被拒绝时只迁移当前会话。'
            )
        }
    ];
    for (const { mode, label, title } of modes) {
        const tab = el('button', `csm-switch-tab${cli.switchMode === mode ? ' csm-switch-tab-active' : ''}`, label);
        const unavailable = (mode === 'failover' && enabledCount < 2) || (mode === 'balance' && enabledCount < 1);
        tab.type = 'button';
        tab.title =
            unavailable ?
                mode === 'failover' ?
                    t('Enable two usable accounts first.', '请先启用两个可用账号。')
                :   t('Enable one usable account first.', '请先启用一个可用账号。')
            :   title;
        tab.disabled = state.busy || unavailable;
        tab.setAttribute('aria-pressed', cli.switchMode === mode ? 'true' : 'false');
        tab.addEventListener('click', () => {
            if (mode === cli.switchMode) {
                return;
            }
            state.busy = true;
            render();
            postToVSCode({ command: 'setCliOAuthSwitchMode', provider: cli.provider, mode });
        });
        tabs.appendChild(tab);
    }
    section.appendChild(tabs);
    return section;
}

// ============= 单个 CLI 账号卡片 =============

function renderCliAccountCard(cli: CliProviderOption, account?: CliOAuthCredentialOption): HTMLElement {
    const card = el('article', 'csm-config-card');
    const accountExpired = isCredentialExpiryDateExpired(account?.expiryDate);
    const hasAccessToken = account?.hasAccessToken ?? cli.isAuthenticated;
    const authenticationRejected = account?.usage?.authenticationRejected === true;
    const isAuthenticated =
        account ? hasAccessToken && !accountExpired && !authenticationRejected : cli.isAuthenticated;

    // 头部：账号标识 + 认证状态徽标
    const cardHead = el('div', 'csm-config-card-head');
    const cardTitleWrap = el('div', 'csm-config-card-titlewrap');
    const cardTitleText =
        account ? account.label || account.name
        : cli.loading ? t('Checking', '检查中')
        : cli.isAuthenticated ? (cli.usage?.email ?? cli.usage?.planType ?? t('CLI Default', 'CLI 默认'))
        : t('Not signed in', '未登录');
    cardTitleWrap.appendChild(el('span', 'csm-config-card-title', cardTitleText));
    cardHead.appendChild(cardTitleWrap);
    if (account?.isActive) {
        cardHead.appendChild(el('span', 'csm-cli-status-ok', t('Active', '活跃')));
    }
    cardHead.appendChild(
        el(
            'span',
            `csm-cli-status-${
                cli.loading && !account ? 'loading'
                : isAuthenticated ? 'ok'
                : 'warn'
            }`,
            cli.loading && !account ? t('Checking', '检查中')
            : account && !hasAccessToken ? t('Missing token', '缺少令牌')
            : authenticationRejected ? t('Authorization rejected', '授权被拒绝')
            : accountExpired ? t('Expired', '已过期')
            : isAuthenticated ? t('Authenticated', '已认证')
            : t('Not authenticated', '未认证')
        )
    );
    card.appendChild(cardHead);

    // 内容区：元信息（grid 多列）+ 余量（跨整行，与普通 provider 一致）
    const cardBody = el('div', 'csm-config-card-body');

    // CLI 安装状态
    const cliInstalledItem = el('div', 'csm-config-meta-item');
    cliInstalledItem.appendChild(el('div', 'csm-config-meta-label', t('CLI Installed', 'CLI 安装')));
    cliInstalledItem.appendChild(
        el(
            'span',
            cli.loading ? 'csm-cli-status-loading'
            : cli.isCliInstalled ? 'csm-cli-status-ok'
            : 'csm-cli-status-warn',
            cli.loading ? t('Checking...', '检查中...')
            : cli.isCliInstalled ? t('Installed', '已安装')
            : t('Not installed', '未安装')
        )
    );
    cardBody.appendChild(cliInstalledItem);

    // 认证状态详情
    const statusItem = el('div', 'csm-config-meta-item');
    statusItem.appendChild(el('div', 'csm-config-meta-label', t('Auth Status', '认证状态')));
    statusItem.appendChild(
        el(
            'span',
            cli.loading && !account ? 'csm-cli-status-loading'
            : isAuthenticated ? 'csm-cli-status-ok'
            : 'csm-cli-status-warn',
            cli.loading && !account ? t('Checking CLI status...', '正在检查 CLI 状态...')
            : account && !hasAccessToken ? t('Missing access_token', '缺少 access_token')
            : authenticationRejected ? t('Authorization rejected; sign in again', '授权被拒绝，请重新登录')
            : accountExpired ? t('Expired; refresh on use', '已过期；使用时尝试刷新')
            : account ? t('Valid OAuth account', 'OAuth 账号有效')
            : (cli.statusDetail ?? (cli.isAuthenticated ? t('Valid', '有效') : t('Not authenticated', '未认证')))
        )
    );
    cardBody.appendChild(statusItem);

    if (account) {
        const weightItem = el('label', 'csm-config-meta-item csm-cli-routing-weight-item');
        weightItem.appendChild(el('div', 'csm-config-meta-label', t('Routing weight', '路由权重')));
        const weightInput = el('input', 'csm-cli-routing-weight');
        weightInput.type = 'number';
        weightInput.min = '0';
        weightInput.max = '100';
        weightInput.step = '1';
        weightInput.value = String(account.balanceWeight ?? 1);
        weightInput.disabled = state.busy;
        weightInput.setAttribute('aria-label', t('Routing weight for {0}', '{0} 的路由权重', account.name));
        weightInput.addEventListener('change', () => {
            const weight = Number(weightInput.value);
            if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
                weightInput.value = String(account.balanceWeight ?? 1);
                return;
            }
            if (weight === (account.balanceWeight ?? 1)) {
                return;
            }
            state.busy = true;
            render();
            postToVSCode({
                command: 'setCliOAuthWeight',
                provider: cli.provider,
                credentialName: account.name,
                weight
            });
        });
        weightItem.appendChild(weightInput);
        cardBody.appendChild(weightItem);
    }

    // 余量（与普通 provider 一致，在卡片 body 内跨整行）
    if (account?.usage) {
        cardBody.appendChild(renderCliUsage(cli.provider, account.usage, account.name));
    } else if (!account && cli.usage) {
        cardBody.appendChild(renderCliUsage(cli.provider, cli.usage));
    }

    card.appendChild(cardBody);

    // 底部：操作按钮
    const footer = el('div', 'csm-config-card-footer');
    if (account) {
        const activeBtn = el(
            'button',
            account.isActive ? 'csm-btn csm-btn-sm' : 'csm-btn csm-btn-primary csm-btn-sm',
            account.isActive ? t('Active Account', '当前账号') : t('Use Account', '设为活跃')
        );
        activeBtn.type = 'button';
        activeBtn.disabled = state.busy || account.isActive || !account.hasAccessToken;
        activeBtn.addEventListener('click', () => {
            postToVSCode({ command: 'activateCliCredential', provider: cli.provider, credentialName: account.name });
        });
        footer.appendChild(activeBtn);

        const deleteBtn = el('button', 'csm-btn csm-btn-danger csm-btn-sm', t('Delete Account', '删除账号'));
        deleteBtn.type = 'button';
        deleteBtn.disabled = state.busy;
        deleteBtn.addEventListener('click', () => {
            postToVSCode({ command: 'deleteCliCredential', provider: cli.provider, credentialName: account.name });
        });
        footer.appendChild(deleteBtn);
    } else if (cli.loading) {
        const checkingBtn = el('button', 'csm-btn csm-btn-sm', t('Checking...', '检查中...'));
        checkingBtn.disabled = true;
        footer.appendChild(checkingBtn);
    } else if (!account && !cli.loading && cli.isAuthenticated) {
        const removeBtn = el('button', 'csm-btn csm-btn-sm csm-btn-danger', t('Remove Auth', '移除认证'));
        removeBtn.disabled = state.busy;
        removeBtn.addEventListener('click', () => {
            clearMessage();
            renderCliRemoveDialog(cli.displayName, () => {
                postToVSCode({ command: 'removeCliCredential', provider: cli.provider });
            });
        });
        footer.appendChild(removeBtn);
    }

    if (!account && !cli.loading) {
        const refreshBtn = el('button', 'csm-btn csm-btn-primary csm-btn-sm', t('Refresh Auth', '刷新认证'));
        refreshBtn.disabled = state.busy;
        refreshBtn.addEventListener('click', () => {
            clearMessage();
            state.busy = true;
            render();
            postToVSCode({ command: 'setupCli', provider: cli.provider });
        });
        footer.appendChild(refreshBtn);
    }
    if (footer.childElementCount > 0) {
        card.appendChild(footer);
    }

    return card;
}

// ============= Slot 分区 =============

function renderSlotSection(pst: ProviderState, slotState: SlotState, opt: ProviderOption | undefined): HTMLElement {
    const section = el('div', 'csm-slot-section');

    // 槽位标题栏
    const slotHead = el('div', 'csm-slot-head');
    const slotTitle = el('div', 'csm-slot-title');
    if (slotState.isMain) {
        slotTitle.appendChild(el('span', 'csm-slot-tag-main', t('Main', '主')));
    } else {
        slotTitle.appendChild(el('span', 'csm-slot-tag-variant', t('Variant', '副')));
    }
    slotTitle.appendChild(el('span', 'csm-slot-name', slotState.displayName));
    slotTitle.appendChild(el('span', 'csm-slot-count', String(slotState.rows.length)));
    slotHead.appendChild(slotTitle);

    const slotActions = el('div', 'csm-slot-actions');
    const switchTabs = el('div', 'csm-switch-tabs');
    const switchModes: Array<{
        mode: SlotState['switchMode'];
        label: string;
        title: string;
    }> = [
        {
            mode: 'off',
            label: t('Off', '手动切换'),
            title: t('Switch configurations manually.', '仅手动切换配置。')
        },
        {
            mode: 'failover',
            label: t('Failover', '故障切换'),
            title: t(
                'When enabled, any request error counts toward failover. After 3 consecutive failures, activate the next saved configuration. User cancellation does not count or stop a switch already started.',
                '开启后，任意请求错误均计入连续失败，达到 3 次后激活下一套配置；主动取消不计入，也不阻止已开始的切换。'
            )
        },
        {
            mode: 'balance',
            label: t('Balance', '负载均衡'),
            title: t(
                'The leader window assigns conversation turns and sub-agent sessions based on weight and current load. Consecutive turns may use the same key. Configurations with a weight of 0 receive no new requests. Without a leader, requests fall back to the default primary key. A key is temporarily excluded for 5 minutes after 3 consecutive failures.',
                '由主窗口（Leader）根据权重和当前负载分配对话轮次及子代理会话，连续轮次可以使用同一个 Key。权重为 0 的配置不再接收新请求。没有主窗口时，请求回退到默认的主使用 Key。某个 Key 连续失败 3 次后，将暂停使用 5 分钟。'
            )
        }
    ];
    for (const switchMode of switchModes) {
        const tab = el(
            'button',
            `csm-switch-tab${slotState.switchMode === switchMode.mode ? ' csm-switch-tab-active' : ''}`,
            switchMode.label
        );
        tab.type = 'button';
        const needsConfigurations =
            slotState.switchMode === 'off' &&
            (switchMode.mode === 'failover' ? slotState.rows.length < 2
            : switchMode.mode === 'balance' ? slotState.rows.length === 0
            : false);
        tab.title =
            needsConfigurations ?
                switchMode.mode === 'balance' ?
                    t('Add a saved configuration first.', '请先添加已保存配置。')
                :   t('Add at least 2 saved configurations first.', '请先添加至少 2 套已保存配置。')
            :   switchMode.title;
        tab.disabled = state.busy || needsConfigurations;
        tab.setAttribute('aria-pressed', slotState.switchMode === switchMode.mode ? 'true' : 'false');
        tab.addEventListener('click', () => {
            if (switchMode.mode === slotState.switchMode) {
                return;
            }
            clearMessage();
            state.busy = true;
            render();
            postToVSCode({ command: 'setSwitchMode', slot: slotState.slot, mode: switchMode.mode });
        });
        switchTabs.appendChild(tab);
    }
    slotActions.appendChild(switchTabs);

    const addBtn = el(
        'button',
        'csm-btn csm-btn-primary csm-btn-sm',
        state.addFormSlot === slotState.slot ? t('Collapse', '收起') : t('+ Add', '+ 新增')
    );
    addBtn.addEventListener('click', () => {
        const nextAddFormSlot = state.addFormSlot === slotState.slot ? null : slotState.slot;
        if (nextAddFormSlot !== state.addFormSlot) {
            state.addFormDraft = null;
        }
        state.addFormSlot = nextAddFormSlot;
        clearMessage();
        render();
    });
    slotActions.appendChild(addBtn);
    slotHead.appendChild(slotActions);
    section.appendChild(slotHead);

    const hasRows = slotState.rows.length > 0;
    const body = el('div', 'csm-slot-body');

    // 新增表单
    if (state.addFormSlot === slotState.slot) {
        body.appendChild(renderAddForm(slotState, opt));
    }

    // 配置表格
    if (!hasRows) {
        if (state.addFormSlot !== slotState.slot) {
            const empty = el('div', 'csm-slot-empty');
            empty.appendChild(
                el(
                    'div',
                    'csm-empty-text',
                    t(
                        'No configurations for {0}. Use the add button at the top right to create one.',
                        '"{0}" 暂无配置，请点击右上角"新增"。',
                        slotState.displayName
                    )
                )
            );
            body.appendChild(empty);
        }
    } else {
        body.appendChild(renderSlotCards(slotState));
    }

    section.appendChild(body);

    return section;
}

// ============= 外部依赖（由 app.ts 注入） =============

let render: () => void = () => {};
let renderCliRemoveDialog: (displayName: string, onConfirm: () => void) => void = () => {};

export function initDetail(deps: {
    render: () => void;
    renderCliRemoveDialog: (displayName: string, onConfirm: () => void) => void;
}): void {
    render = deps.render;
    renderCliRemoveDialog = deps.renderCliRemoveDialog;
}
