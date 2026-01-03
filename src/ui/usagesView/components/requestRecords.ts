/**
 * 请求记录组件
 * 负责渲染请求记录表格
 */

import type { ExtendedTokenRequestLog } from '../types';
import { createElement } from '../../utils';
import { formatTokens, postToVSCode } from '../utils';

// ============= 工具函数 =============

/**
 * 改变页码
 */
export function changePage(date: string, page: number): void {
    // 设置加载状态
    if (window.usagesSetLoading) {
        window.usagesSetLoading('pageRecords', true);
    }
    postToVSCode({ command: 'changePage', date, page });
}

/**
 * 创建分页组件
 */
function createPagination(currentPage: number, totalPages: number, totalRecords: number): HTMLElement {
    const container = createElement('div', 'pagination');

    // 上一页按钮
    const prevBtn = createElement('button') as HTMLButtonElement;
    prevBtn.textContent = '上一页';
    prevBtn.disabled = currentPage <= 1;
    prevBtn.onclick = () => {
        if (currentPage > 1 && window.usagesState?.selectedDate) {
            changePage(window.usagesState.selectedDate, currentPage - 1);
        }
    };
    container.appendChild(prevBtn);

    // 第1页按钮（首页）
    const firstPageBtn = createElement('button') as HTMLButtonElement;
    firstPageBtn.textContent = '1';
    firstPageBtn.className = `page-number${currentPage === 1 ? ' active' : ''}`;
    firstPageBtn.onclick = () => {
        if (currentPage !== 1 && window.usagesState?.selectedDate) {
            changePage(window.usagesState.selectedDate, 1);
        }
    };
    container.appendChild(firstPageBtn);

    // 页码按钮（中间部分）
    const maxPages = 5;
    let startPage = Math.max(2, currentPage - Math.floor(maxPages / 2));
    const endPage = Math.min(totalPages - 1, startPage + maxPages - 1);

    // 调整起始位置
    if (endPage - startPage < maxPages - 1) {
        startPage = Math.max(2, endPage - maxPages + 1);
    }

    // 显示前导省略号（如果第1页和第一个显示页码之间有间隔）
    if (startPage > 2) {
        const ellipsis = createElement('span');
        ellipsis.textContent = '...';
        container.appendChild(ellipsis);
    }

    for (let i = startPage; i <= endPage; i++) {
        const pageBtn = createElement('button') as HTMLButtonElement;
        pageBtn.textContent = String(i);
        pageBtn.className = `page-number${i === currentPage ? ' active' : ''}`;
        pageBtn.onclick = () => {
            if (i !== currentPage && window.usagesState?.selectedDate) {
                changePage(window.usagesState.selectedDate, i);
            }
        };
        container.appendChild(pageBtn);
    }

    // 显示尾部省略号（如果最后一个显示页码和最后一页之间有间隔）
    if (endPage < totalPages - 1) {
        const ellipsis = createElement('span');
        ellipsis.textContent = '...';
        container.appendChild(ellipsis);
    }

    // 最后一页按钮（尾页）- 只有当 totalPages > 1 时才显示
    if (totalPages > 1) {
        const lastPageBtn = createElement('button') as HTMLButtonElement;
        lastPageBtn.textContent = String(totalPages);
        lastPageBtn.className = `page-number${currentPage === totalPages ? ' active' : ''}`;
        lastPageBtn.onclick = () => {
            if (currentPage !== totalPages && window.usagesState?.selectedDate) {
                changePage(window.usagesState.selectedDate, totalPages);
            }
        };
        container.appendChild(lastPageBtn);
    }

    // 下一页按钮
    const nextBtn = createElement('button') as HTMLButtonElement;
    nextBtn.textContent = '下一页';
    nextBtn.disabled = currentPage >= totalPages;
    nextBtn.onclick = () => {
        if (currentPage < totalPages && window.usagesState?.selectedDate) {
            changePage(window.usagesState.selectedDate, currentPage + 1);
        }
    };
    container.appendChild(nextBtn);

    // 页码信息
    const info = createElement('span', 'pagination-info');
    const start = (currentPage - 1) * 20 + 1;
    const end = Math.min(currentPage * 20, totalRecords);
    info.textContent = `${start}-${end} / ${totalRecords}`;
    container.appendChild(info);

    return container;
}

// ============= 组件渲染 =============

/**
 * 创建请求记录表格
 */
function createRequestRecordsTable(records: ExtendedTokenRequestLog[]): HTMLElement {
    const table = createElement('table', 'records-table');

    // 表头
    const thead = createElement('thead');
    const headerRow = createElement('tr');

    const headers = ['时间', '提供商', '模型', '输入Tokens', '缓存命中', '输出Tokens', '消耗Tokens', '状态'];
    headers.forEach(h => {
        const th = createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // 表体
    const tbody = createElement('tbody');

    if (records && records.length > 0) {
        records.forEach(record => {
            const row = createElement('tr');

            const time = createElement('td');
            if (record.timestamp) {
                try {
                    const date = new Date(record.timestamp);
                    time.textContent = date.toLocaleTimeString();
                } catch {
                    time.textContent = '-';
                }
            } else {
                time.textContent = '-';
            }

            const provider = createElement('td');
            provider.textContent = record.providerName || '-';

            const model = createElement('td');
            model.textContent = record.modelName || '-';

            const input = createElement('td');
            // 根据状态决定显示实际值还是预估值
            if (record.status === 'completed' && record.rawUsage && record.totalTokens > 0) {
                // 完成状态且有实际值：显示实际值
                input.textContent = formatTokens(record.actualInput);
            } else {
                // 预估或失败状态或无实际值：显示预估值（带 ~ 前缀），否则显示 '-'
                if (record.estimatedInput !== undefined && record.estimatedInput > 0) {
                    input.textContent = `~${formatTokens(record.estimatedInput)}`;
                } else {
                    input.textContent = '-';
                }
            }

            const cache = createElement('td');
            if (record.status === 'completed' && record.cacheReadTokens > 0) {
                cache.textContent = formatTokens(record.cacheReadTokens);
            } else {
                cache.textContent = '-';
            }

            const output = createElement('td');
            if (record.status === 'completed' && record.outputTokens > 0) {
                output.textContent = formatTokens(record.outputTokens);
            } else {
                output.textContent = '-';
            }

            const total = createElement('td');
            if (record.status === 'completed' && record.totalTokens > 0) {
                total.textContent = formatTokens(record.totalTokens);
            } else {
                total.textContent = '-';
            }

            const status = createElement('td');
            status.className = record.status === 'completed' ? 'status-completed' : '';
            status.textContent = record.status === 'completed' ? '✅' : record.status === 'failed' ? '❌' : '⏳';

            row.appendChild(time);
            row.appendChild(provider);
            row.appendChild(model);
            row.appendChild(input);
            row.appendChild(cache);
            row.appendChild(output);
            row.appendChild(total);
            row.appendChild(status);
            tbody.appendChild(row);
        });
    } else {
        const emptyRow = createElement('tr');
        const emptyCell = createElement('td', '', { colSpan: 8 });
        emptyCell.textContent = '暂无请求记录';
        emptyCell.style.textAlign = 'center';
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
    }

    table.appendChild(tbody);

    return table;
}

/**
 * 创建请求记录区域
 */
export function createRequestRecordsSection(records: ExtendedTokenRequestLog[], currentPage: number): HTMLElement {
    const section = createElement('div');
    section.id = 'records-container';

    const wrapper = createElement('div');

    const totalRecords = records.length;
    const totalPages = Math.ceil(totalRecords / 20) || 1;

    // 分页组件
    const paginationTop = createPagination(currentPage, totalPages, totalRecords);
    wrapper.appendChild(paginationTop);

    // 表格
    const startIndex = (currentPage - 1) * 20;
    const endIndex = Math.min(startIndex + 20, totalRecords);
    const pageRecords = records.slice(startIndex, endIndex);
    wrapper.appendChild(createRequestRecordsTable(pageRecords));

    // 分页组件（底部）
    const paginationBottom = createPagination(currentPage, totalPages, totalRecords);
    wrapper.appendChild(paginationBottom);

    section.appendChild(wrapper);

    return section;
}
