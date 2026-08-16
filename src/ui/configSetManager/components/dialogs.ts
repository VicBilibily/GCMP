/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - 对话框渲染
 *  renderDeleteDialog / renderPassphraseDialog / renderRestoreDialog
 *--------------------------------------------------------------------------------------------*/

import type { SlotState, ConfigSetRow, SlotItemSelection, UploadSlotSnapshot, ActiveKeyAction } from '../types';
import { el, t, state, postToVSCode, showMessage, clearMessage } from './state';

// ============= 删除确认对话框 =============

export function renderDeleteDialog(slotState: SlotState, row: ConfigSetRow): void {
    const existing = document.querySelector('.csm-delete-overlay');
    if (existing) {
        existing.remove();
    }

    const mainCopy = t(
        'Delete configuration "{0}" for {1}?',
        '确认删除 {1} 的配置"{0}"吗？',
        row.label,
        slotState.displayName
    );
    const subCopy =
        row.isActive ?
            t(
                'It is currently active, and the current key will remain in effect until the next switch.',
                '它当前处于激活状态，现有 Key 会继续生效直到下次切换。'
            )
        :   t('This will also remove its stored API key.', '这也会删除它保存的 API Key。');

    const overlay = el('div', 'csm-restore-overlay csm-delete-overlay');
    const dialog = el('div', 'csm-restore-dialog csm-confirm-dialog');
    dialog.appendChild(el('h3', '', t('Confirm deletion', '确认删除')));
    const copy = el('div', 'csm-dialog-copy csm-confirm-copy');
    copy.appendChild(el('div', 'csm-dialog-copy-main', mainCopy));
    copy.appendChild(el('div', 'csm-dialog-copy-sub', subCopy));
    const body = el('div', 'csm-dialog-body');
    body.appendChild(copy);
    dialog.appendChild(body);

    const actions = el('div', 'csm-restore-actions');
    const cancelBtn = el('button', 'csm-btn', t('Cancel', '取消'));
    cancelBtn.addEventListener('click', () => overlay.remove());
    const confirmBtn = el('button', 'csm-btn csm-btn-danger', t('Delete', '删除'));
    confirmBtn.addEventListener('click', () => {
        overlay.remove();
        state.busy = true;
        render();
        postToVSCode({ command: 'remove', slot: slotState.slot, id: row.id });
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// ============= 停用确认对话框 =============

export function renderDeactivateDialog(slotState: SlotState, row: ConfigSetRow, onConfirm: () => void): void {
    const existing = document.querySelector('.csm-delete-overlay');
    if (existing) {
        existing.remove();
    }

    const overlay = el('div', 'csm-restore-overlay csm-delete-overlay');
    const dialog = el('div', 'csm-restore-dialog csm-confirm-dialog');
    dialog.appendChild(el('h3', '', t('Confirm deactivation', '确认停用')));
    const copy = el('div', 'csm-dialog-copy csm-confirm-copy');
    copy.appendChild(
        el(
            'div',
            'csm-dialog-copy-main',
            t(
                'Deactivate configuration "{0}" for {1}?',
                '确认停用 {1} 的配置"{0}"吗？',
                row.label,
                slotState.displayName
            )
        )
    );
    copy.appendChild(
        el(
            'div',
            'csm-dialog-copy-sub',
            t(
                'The active API key will be cleared; the saved configuration is kept and can be reactivated anytime.',
                '当前生效的 API Key 将被清除；已保存的配置保留，可随时重新激活。'
            )
        )
    );
    const body = el('div', 'csm-dialog-body');
    body.appendChild(copy);
    dialog.appendChild(body);

    const actions = el('div', 'csm-restore-actions');
    const cancelBtn = el('button', 'csm-btn', t('Cancel', '取消'));
    cancelBtn.addEventListener('click', () => overlay.remove());
    const confirmBtn = el('button', 'csm-btn csm-btn-danger', t('Deactivate', '停用'));
    confirmBtn.addEventListener('click', () => {
        overlay.remove();
        onConfirm();
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// ============= CLI 凭证移除确认对话框 =============

export function renderCliRemoveDialog(displayName: string, onConfirm: () => void): void {
    const existing = document.querySelector('.csm-delete-overlay');
    if (existing) {
        existing.remove();
    }

    const overlay = el('div', 'csm-restore-overlay csm-delete-overlay');
    const dialog = el('div', 'csm-restore-dialog csm-confirm-dialog');
    dialog.appendChild(el('h3', '', t('Remove authentication', '移除认证')));
    const copy = el('div', 'csm-dialog-copy csm-confirm-copy');
    copy.appendChild(
        el(
            'div',
            'csm-dialog-copy-main',
            t('Remove OAuth authentication for {0}?', '确认移除 {0} 的 OAuth 认证吗？', displayName)
        )
    );
    copy.appendChild(
        el(
            'div',
            'csm-dialog-copy-sub',
            t(
                'The credential file will be located in the file manager. Delete it manually to complete the removal.',
                '将在文件管理器中定位凭证文件，请手动删除该文件以完成移除。'
            )
        )
    );
    const body = el('div', 'csm-dialog-body');
    body.appendChild(copy);
    dialog.appendChild(body);

    const actions = el('div', 'csm-restore-actions');
    const cancelBtn = el('button', 'csm-btn', t('Cancel', '取消'));
    cancelBtn.addEventListener('click', () => overlay.remove());
    const confirmBtn = el('button', 'csm-btn csm-btn-danger', t('Locate File', '定位文件'));
    confirmBtn.addEventListener('click', () => {
        overlay.remove();
        onConfirm();
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// ============= 口令输入对话框 =============

export function renderPassphraseDialog(error?: string): void {
    const existing = document.querySelector('.csm-passphrase-overlay');
    if (existing) {
        existing.remove();
    }

    const overlay = el('div', 'csm-restore-overlay csm-passphrase-overlay');
    const dialog = el('div', 'csm-restore-dialog csm-passphrase-dialog');
    dialog.appendChild(el('h3', '', t('Enter passphrase', '输入口令')));
    const body = el('div', 'csm-dialog-body');
    body.appendChild(
        el(
            'p',
            'csm-dialog-copy',
            t(
                'This sync data was encrypted with a different passphrase. Enter the passphrase used when uploading.',
                '该同步数据使用了不同的加密口令。请输入上传时使用的口令。'
            )
        )
    );

    const errorText = el('div', 'csm-dialog-error');
    if (error) {
        errorText.textContent = error;
    }
    body.appendChild(errorText);

    const field = el('div', 'csm-field');
    field.appendChild(el('label', '', t('Passphrase', '口令')));
    const input = el('input', 'csm-input csm-passphrase-input') as HTMLInputElement;
    input.type = 'password';
    input.placeholder = t('Enter passphrase', '请输入口令');
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            submit();
        }
    });
    field.appendChild(input);
    body.appendChild(field);
    dialog.appendChild(body);

    const actions = el('div', 'csm-restore-actions');
    const cancelBtn = el('button', 'csm-btn', t('Cancel', '取消'));
    cancelBtn.addEventListener('click', () => overlay.remove());
    const confirmBtn = el('button', 'csm-btn csm-btn-primary', t('Continue', '继续'));
    confirmBtn.addEventListener('click', () => submit());
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);

    function submit(): void {
        const passphrase = input.value.trim();
        if (!passphrase) {
            errorText.textContent = t('Passphrase is required', '请输入口令');
            input.focus();
            return;
        }
        overlay.remove();
        clearMessage();
        state.busy = true;
        render();
        postToVSCode({ command: 'downloadWithPassphrase', passphrase });
    }

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    input.focus();
}

// ============= 逐项选择对话框（恢复 / 上传共用骨架） =============

/** 选择对话框中的配置项 */
interface SlotSelectionItem {
    id: string;
    text: string;
    /** 尾部标记（如"远端激活"/"使用中"/"缺少 Key"） */
    tag?: string;
    /** 禁用（不可勾选，如缺 Key 的本地上传项） */
    disabled?: boolean;
}

/** 选择对话框中的槽位分组 */
interface SlotSelectionGroup {
    title: string;
    /** 主控复选框内嵌分组标题行（该组恰含一个槽位时使用，标题随滚动吸顶） */
    titleCheckbox?: boolean;
    slots: Array<{
        key: string;
        label: string;
        defaultChecked: boolean;
        /** 全选时才显示的提示（如本地独有将被移除） */
        warningText?: string;
        items: SlotSelectionItem[];
    }>;
}

/** 把分组渲染进 body，并维护 slot -> 已选配置项 id 的勾选状态 */
function buildSlotSelectionBody(
    body: HTMLElement,
    groups: SlotSelectionGroup[],
    checked: Map<string, Set<string>>
): void {
    for (const group of groups) {
        const groupEl = el('div', 'csm-restore-group');
        // titleCheckbox 模式下标题行不预置文本，改由槽位行渲染（复选框 + 标题文本）
        const titleEl = el('div', 'csm-restore-group-title', group.titleCheckbox ? undefined : group.title);
        groupEl.appendChild(titleEl);
        for (const slot of group.slots) {
            const selectable = slot.items.filter(it => !it.disabled);
            const picked = new Set<string>(slot.defaultChecked ? selectable.map(it => it.id) : []);
            checked.set(slot.key, picked);

            const slotRow = group.titleCheckbox ? titleEl : el('div', 'csm-restore-item');
            const slotCb = el('input') as HTMLInputElement;
            slotCb.type = 'checkbox';
            slotCb.disabled = selectable.length === 0;
            slotRow.appendChild(slotCb);
            slotRow.appendChild(document.createTextNode(group.titleCheckbox ? group.title : slot.label));
            if (!group.titleCheckbox) {
                groupEl.appendChild(slotRow);
            }

            const warn = slot.warningText ? el('div', 'csm-restore-localonly', slot.warningText) : undefined;
            if (warn) {
                groupEl.appendChild(warn);
            }

            const itemInputs: HTMLInputElement[] = [];
            const syncSlotState = (): void => {
                slotCb.checked = selectable.length > 0 && picked.size === selectable.length;
                slotCb.indeterminate = picked.size > 0 && picked.size < selectable.length;
                if (warn) {
                    // 仅整槽全选时提示才生效
                    warn.style.display = picked.size === selectable.length && selectable.length > 0 ? '' : 'none';
                }
            };
            slotCb.addEventListener('change', () => {
                picked.clear();
                if (slotCb.checked) {
                    for (const it of selectable) {
                        picked.add(it.id);
                    }
                }
                for (const input of itemInputs) {
                    input.checked = slotCb.checked;
                }
                syncSlotState();
            });

            const itemList = el('div', 'csm-restore-slot-items');
            for (const it of slot.items) {
                const row = el('div', 'csm-restore-item csm-restore-subitem');
                const cb = el('input') as HTMLInputElement;
                cb.type = 'checkbox';
                cb.disabled = it.disabled ?? false;
                cb.checked = !it.disabled && picked.has(it.id);
                cb.addEventListener('change', () => {
                    if (cb.checked) {
                        picked.add(it.id);
                    } else {
                        picked.delete(it.id);
                    }
                    syncSlotState();
                });
                if (!it.disabled) {
                    itemInputs.push(cb);
                }
                row.appendChild(cb);
                row.appendChild(document.createTextNode(it.text));
                if (it.tag) {
                    row.appendChild(el('span', 'csm-restore-active-tag', it.tag));
                }
                itemList.appendChild(row);
            }
            groupEl.appendChild(itemList);
            syncSlotState();
        }
        body.appendChild(groupEl);
    }
}

/** 打开逐项选择对话框；onConfirm 返回错误文案则中止关闭 */
function openSelectionDialog(options: {
    title: string;
    confirmLabel: string;
    /** 对话框顶部提示（如远端不可读仅允许全量上传） */
    noticeText?: string;
    fillBody: (body: HTMLElement, checked: Map<string, Set<string>>) => void;
    buildSelections?: (checked: Map<string, Set<string>>) => SlotItemSelection[];
    onConfirm: (selections: SlotItemSelection[]) => string | undefined;
    onCancel?: () => void;
}): void {
    document.querySelector('.csm-restore-overlay')?.remove();

    const overlay = el('div', 'csm-restore-overlay');
    const dialog = el('div', 'csm-restore-dialog');
    dialog.appendChild(el('h3', '', options.title));
    // 顶部提示固定在标题下，不随内容区滚动
    if (options.noticeText) {
        dialog.appendChild(el('div', 'csm-restore-notice', options.noticeText));
    }

    const body = el('div', 'csm-dialog-body');
    const checked = new Map<string, Set<string>>();
    options.fillBody(body, checked);
    dialog.appendChild(body);

    const actions = el('div', 'csm-restore-actions');
    const cancelBtn = el('button', 'csm-btn', t('Cancel', '取消'));
    cancelBtn.addEventListener('click', () => {
        options.onCancel?.();
        overlay.remove();
    });
    const confirmBtn = el('button', 'csm-btn csm-btn-primary', options.confirmLabel);
    confirmBtn.addEventListener('click', () => {
        const selections =
            options.buildSelections?.(checked) ??
            Array.from(checked.entries())
                .map(([slot, ids]) => ({ slot, itemIds: Array.from(ids) }))
                .filter(sel => sel.itemIds.length > 0);
        const error = options.onConfirm(selections);
        if (error) {
            showMessage('warning', error);
            return;
        }
        overlay.remove();
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

/** 恢复/上传共用的新增-更新-无变更分组 */
const STATUS_GROUPS: Array<['new' | 'update' | 'unchanged', string]> = [
    ['new', t('New', '待新增')],
    ['update', t('Update', '待更新')],
    ['unchanged', t('Unchanged', '无需变更')]
];

// ============= 恢复选择对话框 =============

export function renderRestoreDialog(): void {
    if (!state.restoreSnapshots || state.restoreSnapshots.length === 0) {
        showMessage('warning', t('No remote data to restore', '远端无可恢复数据'));
        return;
    }
    const snapshots = state.restoreSnapshots;

    const groups: SlotSelectionGroup[] = [];
    for (const [status, label] of STATUS_GROUPS) {
        const snaps = snapshots.filter(s => s.status === status);
        if (snaps.length === 0) {
            continue;
        }
        groups.push({
            title: `${label} (${snaps.length})`,
            slots: snaps.map(snap => ({
                key: snap.slot,
                label: `${snap.displayName} (${snap.itemCount})`,
                defaultChecked: status !== 'unchanged',
                items: snap.items.map(it => ({
                    id: it.id,
                    text: it.siteLabel ? `${it.label} · ${it.siteLabel}` : it.label
                }))
            }))
        });
    }

    openSelectionDialog({
        title: t('Select configurations to restore', '选择要恢复的配置'),
        confirmLabel: t('Restore', '恢复'),
        fillBody: (body, checked) => buildSlotSelectionBody(body, groups, checked),
        onCancel: () => {
            state.restoreSnapshots = null;
            postToVSCode({ command: 'discardRestorePrep' });
        },
        onConfirm: selections => {
            if (selections.length === 0) {
                return t('Select at least one configuration', '请至少选择一项配置');
            }
            state.busy = true;
            render();
            postToVSCode({ command: 'restore', selections });
            return undefined;
        }
    });
}

// ============= 上传选择对话框 =============

export function renderUploadDialog(): void {
    if (!state.uploadSnapshots || state.uploadSnapshots.length === 0) {
        showMessage('warning', t('No switchable API keys to sync.', '暂无可切换的 API Key。'));
        return;
    }
    const snapshots = state.uploadSnapshots;

    const toGroupSlots = (snaps: UploadSlotSnapshot[], defaultChecked: boolean): SlotSelectionGroup['slots'] =>
        snaps.map(snap => ({
            key: snap.slot,
            label: `${snap.displayName} (${snap.items.length})`,
            defaultChecked,
            warningText:
                snap.remoteOnlyLabels && snap.remoteOnlyLabels.length > 0 ?
                    t('Remote-only will be removed: {0}', '远端独有将被移除：{0}', snap.remoteOnlyLabels.join(', '))
                :   undefined,
            items: snap.items.map(it => ({
                id: it.id,
                text: it.siteLabel ? `${it.label} · ${it.siteLabel}` : it.label,
                tag:
                    !it.hasKey ? t('No API Key', '缺少 Key')
                    : it.isActive ? t('In use', '使用中')
                    : undefined,
                disabled: !it.hasKey
            }))
        }));

    const groups: SlotSelectionGroup[] = [];
    for (const [status, label] of STATUS_GROUPS) {
        const snaps = snapshots.filter(s => s.status === status);
        if (snaps.length === 0) {
            continue;
        }
        groups.push({ title: `${label} (${snaps.length})`, slots: toGroupSlots(snaps, status !== 'unchanged') });
    }
    // 远端不可读或槽位状态缺失（如全槽缺 Key 不参与 diff）时归入"待上传"
    const unclassified = snapshots.filter(s => s.status === undefined);
    if (unclassified.length > 0) {
        groups.push({ title: t('Pending upload', '待上传'), slots: toGroupSlots(unclassified, true) });
    }

    openSelectionDialog({
        title: t('Select configurations to upload', '选择要上传的配置'),
        confirmLabel: t('Upload', '上传'),
        noticeText:
            state.uploadRemoteReadable ? undefined : (
                t(
                    'Remote sync data is currently unreadable, so upload is blocked until the remote data can be read safely.',
                    '远端同步数据暂不可读，当前已阻止上传，需先恢复远端可读状态。'
                )
            ),
        fillBody: (body, checked) => buildSlotSelectionBody(body, groups, checked),
        buildSelections: checked => {
            const selections: SlotItemSelection[] = [];
            for (const snap of snapshots) {
                const picked = Array.from(checked.get(snap.slot) ?? []);
                if (picked.length === 0) {
                    continue;
                }
                const selectableIds = snap.items.filter(it => it.hasKey).map(it => it.id);
                const isFullSlot = picked.length === selectableIds.length;
                selections.push({
                    slot: snap.slot,
                    itemIds: picked,
                    removeItemIds: isFullSlot ? snap.remoteOnlyIds : undefined
                });
            }
            return selections;
        },
        onConfirm: selections => {
            if (selections.length === 0) {
                return t('Select at least one configuration', '请至少选择一项配置');
            }
            if (!state.uploadRemoteReadable) {
                return t(
                    'Remote sync data is unreadable. Retry after the remote data can be read safely.',
                    '远端数据暂不可读，请先恢复远端可读状态后再重试。'
                );
            }
            state.busy = true;
            render();
            postToVSCode({ command: 'uploadSelected', selections });
            return undefined;
        }
    });
}

// ============= 生效配置对话框（单选激活 / 取消撤销） =============

export function renderActiveKeysDialog(): void {
    if (!state.activeSnapshots || state.activeSnapshots.length === 0) {
        state.activeSnapshots = null;
        showMessage('info', t('No saved configurations yet.', '暂无已保存的配置。'));
        return;
    }
    document.querySelector('.csm-restore-overlay')?.remove();
    const snapshots = state.activeSnapshots;
    // 每个槽位当前选中的配置 id；'' = 面板外设置的 Key，undefined = 不激活
    const selected = new Map<string, string | undefined>();
    for (const snap of snapshots) {
        selected.set(snap.slot, snap.activeId ?? (snap.outsideActive ? '' : undefined));
    }

    const overlay = el('div', 'csm-restore-overlay');
    const dialog = el('div', 'csm-restore-dialog');
    dialog.appendChild(el('h3', '', t('Manage active configurations', '管理生效配置')));

    // 顶部提示固定在标题下，不随内容区滚动
    dialog.appendChild(
        el(
            'div',
            'csm-restore-notice',
            t(
                'One active configuration per slot. Check to activate, uncheck to deactivate; takes effect after Apply.',
                '每个槽位至多激活一套配置；勾选即激活，取消勾选即撤销，点击应用后生效。'
            )
        )
    );

    const body = el('div', 'csm-dialog-body');
    for (const snap of snapshots) {
        const groupEl = el('div', 'csm-restore-group');
        groupEl.appendChild(el('div', 'csm-restore-group-title', snap.displayName));
        const itemList = el('div', 'csm-restore-slot-items');
        const itemInputs: HTMLInputElement[] = [];
        const addRow = (id: string, text: string, opts?: { disabled?: boolean; tag?: string }): void => {
            const row = el('div', 'csm-restore-item csm-restore-subitem');
            const cb = el('input') as HTMLInputElement;
            cb.type = 'checkbox';
            cb.disabled = opts?.disabled ?? false;
            cb.checked = selected.get(snap.slot) === id;
            cb.addEventListener('change', () => {
                if (cb.checked) {
                    // 单选语义：勾选即取代同槽位其他项
                    selected.set(snap.slot, id);
                    for (const other of itemInputs) {
                        if (other !== cb) {
                            other.checked = false;
                        }
                    }
                } else {
                    selected.set(snap.slot, undefined);
                }
            });
            itemInputs.push(cb);
            row.appendChild(cb);
            row.appendChild(document.createTextNode(text));
            if (opts?.tag) {
                row.appendChild(el('span', 'csm-restore-active-tag', opts.tag));
            }
            itemList.appendChild(row);
        };
        if (snap.outsideActive) {
            addRow('', t('Key set outside this panel', '面板外设置的 Key'), { tag: t('In effect', '当前生效') });
        }
        for (const it of snap.items) {
            addRow(it.id, it.siteLabel ? `${it.label} · ${it.siteLabel}` : it.label, {
                disabled: !it.hasKey,
                tag: !it.hasKey ? t('No API Key', '缺少 Key') : undefined
            });
        }
        groupEl.appendChild(itemList);
        body.appendChild(groupEl);
    }
    dialog.appendChild(body);

    const actions = el('div', 'csm-restore-actions');
    const cancelBtn = el('button', 'csm-btn', t('Cancel', '取消'));
    cancelBtn.addEventListener('click', () => {
        state.activeSnapshots = null;
        overlay.remove();
    });
    const applyBtn = el('button', 'csm-btn csm-btn-primary', t('Apply', '应用'));
    applyBtn.addEventListener('click', () => {
        const actions: ActiveKeyAction[] = [];
        const outsideSlotsToClear: string[] = [];
        for (const snap of snapshots) {
            const initial = snap.activeId ?? (snap.outsideActive ? '' : undefined);
            const current = selected.get(snap.slot);
            if (current === initial || current === '') {
                continue;
            }
            if (initial === '' && current === undefined) {
                outsideSlotsToClear.push(snap.displayName);
                actions.push({ slot: snap.slot, activateId: current, clearOutsideKey: true });
                continue;
            }
            actions.push({ slot: snap.slot, activateId: current });
        }
        if (
            outsideSlotsToClear.length > 0 &&
            !window.confirm(
                t(
                    'This will delete the current API key set outside this panel for: {0}. Continue?',
                    '这将删除以下槽位在面板外设置的当前 API Key：{0}。是否继续？',
                    outsideSlotsToClear.join('、')
                )
            )
        ) {
            return;
        }
        overlay.remove();
        state.activeSnapshots = null;
        if (actions.length === 0) {
            return;
        }
        state.busy = true;
        render();
        postToVSCode({ command: 'applyActiveKeys', actions });
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(applyBtn);
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// ============= 远端配置管理对话框（勾选保留，未选删除） =============

export function renderRemoteConfigsDialog(): void {
    if (!state.remoteSnapshots || state.remoteSnapshots.length === 0) {
        state.remoteSnapshots = null;
        showMessage('warning', t('No remote data to manage', '远端无可管理的配置'));
        return;
    }
    const snapshots = state.remoteSnapshots;

    // 每个槽位一个吸顶分组，友好名称 + 数量作为标题，主控复选框内嵌标题行
    const groups: SlotSelectionGroup[] = snapshots.map(snap => {
        const title = `${snap.displayName} (${snap.items.length})`;
        return {
            title,
            titleCheckbox: true,
            slots: [
                {
                    key: snap.slot,
                    label: title,
                    defaultChecked: true,
                    items: snap.items.map(it => ({
                        id: it.id,
                        text: it.siteLabel ? `${it.label} · ${it.siteLabel}` : it.label
                    }))
                }
            ]
        };
    });

    openSelectionDialog({
        title: t('Manage remote configurations', '管理远端配置'),
        confirmLabel: t('Apply', '应用'),
        noticeText: t(
            'Uncheck configurations to delete them from the remote Gist; local configurations are not affected. Takes effect after Apply.',
            '取消勾选的配置将从远端 Gist 删除（不影响本地配置），点击应用后生效。'
        ),
        fillBody: (body, checked) => buildSlotSelectionBody(body, groups, checked),
        onCancel: () => {
            state.remoteSnapshots = null;
        },
        onConfirm: selections => {
            // 显式移除清单 = 对话框中展示过但未勾选的项；期间远端新增的项不受影响
            const keepMap = new Map(selections.map(sel => [sel.slot, new Set(sel.itemIds)]));
            const remove: SlotItemSelection[] = [];
            for (const snap of snapshots) {
                const kept = keepMap.get(snap.slot);
                const removedIds = snap.items.filter(it => !kept?.has(it.id)).map(it => it.id);
                if (removedIds.length > 0) {
                    remove.push({ slot: snap.slot, itemIds: removedIds });
                }
            }
            if (remove.length === 0) {
                // 全部保留 = 无变更，直接关闭
                state.remoteSnapshots = null;
                return undefined;
            }
            state.busy = true;
            render();
            postToVSCode({ command: 'applyRemoteConfigs', remove });
            return undefined;
        }
    });
}

// ============= 外部依赖（由 app.ts 注入） =============

let render: () => void = () => {};

export function initDialogs(deps: { render: () => void }): void {
    render = deps.render;
}
