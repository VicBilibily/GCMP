/**
 * Token 用量视图 - 客户端脚本
 * 负责 DOM 创建、事件绑定和与 VSCode 通信
 */

// VSCode API
const vscode = acquireVsCodeApi();

// 全局状态
let currentDate = '';
let currentPage = 1;
let currentDatesLimit = 0;
let isPageChange = false;
let loadingOverlay = null;

/**
 * 初始化用量视图
 * @param {Object} initialData - 初始数据
 */
function initializeUsagesView(initialData) {
    currentDate = initialData.selectedDate;
    currentPage = initialData.currentPage;
    currentDatesLimit = initialData.datesLimit;

    // 创建主 DOM 结构
    createMainDOM(initialData);

    // 绑定事件监听器
    bindEventListeners();
}

/**
 * 创建主 DOM 结构
 * @param {Object} data - 数据对象
 */
function createMainDOM(data) {
    const app = document.getElementById('app');

    // 创建容器
    const container = document.createElement('div');
    container.className = 'container';

    // 创建左侧边栏
    const sidebar = createSidebar(data.dateSummaries, data.selectedDate, data.today);

    // 创建右侧内容区
    const content = createContent(data);

    container.appendChild(sidebar);
    container.appendChild(content);
    app.appendChild(container);

    // 创建加载遮罩
    createLoadingOverlay();

    // 调试日志
    console.log('[UsagesView] DOM created', {
        hasSidebar: !!sidebar,
        hasContent: !!content,
        providersCount: data.providers?.length || 0,
        recordsCount: data.records?.length || 0
    });
}

/**
 * 创建左侧边栏
 * @param {Array} dateSummaries - 日期摘要列表
 * @param {string} selectedDate - 选中的日期
 * @param {string} today - 今日日期
 * @returns {HTMLElement} 边栏元素
 */
function createSidebar(dateSummaries, selectedDate, today) {
    const sidebar = document.createElement('div');
    sidebar.className = 'sidebar';

    // 创建头部
    const header = document.createElement('div');
    header.className = 'sidebar-header';

    const headerTop = document.createElement('div');
    headerTop.className = 'sidebar-header-top';

    const h1 = document.createElement('h1');
    h1.textContent = 'Token 消耗统计';

    const openStorageButton = document.createElement('button');
    openStorageButton.className = 'open-storage-button';
    openStorageButton.textContent = '📁';
    openStorageButton.onclick = openStorageDir;
    openStorageButton.title = '打开存储目录';

    headerTop.appendChild(h1);
    headerTop.appendChild(openStorageButton);

    header.appendChild(headerTop);

    // 创建日期列表
    const dateList = document.createElement('div');
    dateList.className = 'date-list';

    // 生成日期项
    const displaySummaries = dateSummaries.slice(0, currentDatesLimit);
    displaySummaries.forEach(summary => {
        const dateItem = createDateItem(summary, selectedDate, today);
        dateList.appendChild(dateItem);
    });

    // 如果有更多日期,添加加载更多按钮
    if (dateSummaries.length > currentDatesLimit) {
        const loadMoreContainer = createLoadMoreButton(dateSummaries.length);
        dateList.appendChild(loadMoreContainer);
    }

    sidebar.appendChild(header);
    sidebar.appendChild(dateList);

    return sidebar;
}

/**
 * 创建日期项元素
 * @param {Object} summary - 日期摘要
 * @param {string} selectedDate - 选中的日期
 * @param {string} today - 今日日期
 * @returns {HTMLElement} 日期项元素
 */
function createDateItem(summary, selectedDate, today) {
    const isToday = summary.date === today;
    const isSelected = summary.date === selectedDate;
    const displayDate = isToday ? `今日 (${summary.date})` : summary.date;

    const dateItem = document.createElement('div');
    dateItem.className = `date-item ${isSelected ? 'selected' : ''}`;
    dateItem.dataset.date = summary.date;

    const contentDiv = document.createElement('div');
    contentDiv.onclick = () => selectDate(summary.date);

    // 创建头部（标题）
    const header = document.createElement('div');
    header.className = 'date-item-header';

    const title = document.createElement('div');
    title.className = `date-item-title ${isToday ? 'today' : ''}`;
    title.textContent = displayDate;

    header.appendChild(title);

    const stats = document.createElement('div');
    stats.className = 'date-item-stats';
    stats.textContent = `请求: ${summary.total_requests} | Token: ${summary.totalTokensFormatted}`;

    contentDiv.appendChild(header);
    contentDiv.appendChild(stats);
    dateItem.appendChild(contentDiv);

    return dateItem;
}

/**
 * 创建加载更多按钮容器
 * @param {number} totalCount - 总日期数
 * @returns {HTMLElement} 加载更多容器
 */
function createLoadMoreButton(totalCount) {
    const container = document.createElement('div');
    container.className = 'load-more-container';

    const button = document.createElement('button');
    button.className = 'load-more-button';
    button.textContent = `加载更多 (还有 ${totalCount - currentDatesLimit} 天)`;
    button.onclick = loadMoreDates;

    container.appendChild(button);

    return container;
}

/**
 * 创建右侧内容区
 * @param {Object} data - 数据对象
 * @returns {HTMLElement} 内容区元素
 */
function createContent(data) {
    const content = document.createElement('div');
    content.className = 'content';

    // 创建标题
    const title = document.createElement('h2');
    title.id = 'details-title';
    title.textContent = `${data.selectedDate} 使用详情`;

    // 创建详情内容容器
    const detailsContent = document.createElement('div');
    detailsContent.id = 'details-content';

    // 如果有数据,创建详情内容
    if (data.providers.length > 0) {
        // 创建提供商统计
        const providersSection = createProvidersSection(data.providers);
        detailsContent.appendChild(providersSection);

        // 创建各小时用量
        const hourlySection = createHourlySection(data.hourlyStats);
        detailsContent.appendChild(hourlySection);
    } else {
        // 空消息
        const emptyMessage = document.createElement('div');
        emptyMessage.className = 'empty-message';
        emptyMessage.innerHTML = `<p>💡 ${data.selectedDate} 暂无 Token 消耗记录</p>`;
        detailsContent.appendChild(emptyMessage);
    }

    // 创建记录部分
    const recordsTitle = document.createElement('h2');
    recordsTitle.id = 'records-section';
    recordsTitle.textContent = '请求记录';

    const recordsContainer = document.createElement('div');
    recordsContainer.id = 'records-container';

    // 生成记录表格
    const recordsTable = createRecordsTable(data.records, data.currentPage);
    recordsContainer.appendChild(recordsTable);

    content.appendChild(title);
    content.appendChild(detailsContent);
    content.appendChild(recordsTitle);
    content.appendChild(recordsContainer);

    return content;
}

/**
 * 创建提供商统计部分
 * @param {Array} providers - 提供商数据
 * @returns {HTMLElement} 提供商统计元素
 */
function createProvidersSection(providers) {
    const section = document.createElement('div');

    const h2 = document.createElement('h2');
    h2.textContent = '按提供商统计';
    section.appendChild(h2);

    const table = createProvidersTable(providers);
    section.appendChild(table);

    return section;
}

/**
 * 创建提供商表格
 * @param {Array} providers - 提供商数据
 * @returns {HTMLElement} 表格元素
 */
function createProvidersTable(providers) {
    if (providers.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-message';
        empty.textContent = '暂无数据';
        return empty;
    }

    const table = document.createElement('table');

    // 创建表头
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const headers = ['提供商/模型', '输入', '缓存', '输出', '消耗量', '请求数'];
    headers.forEach(headerText => {
        const th = document.createElement('th');
        th.textContent = headerText;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    // 创建表体
    const tbody = document.createElement('tbody');
    providers.forEach(provider => {
        // 提供商行
        const providerRow = createProviderRow(provider);
        tbody.appendChild(providerRow);

        // 模型行
        if (provider.models && provider.models.length > 0) {
            provider.models.forEach(model => {
                const modelRow = createModelRow(model);
                tbody.appendChild(modelRow);
            });
        }
    });

    table.appendChild(thead);
    table.appendChild(tbody);

    return table;
}

/**
 * 创建提供商行
 * @param {Object} provider - 提供商数据
 * @returns {HTMLElement} 表格行元素
 */
function createProviderRow(provider) {
    const row = document.createElement('tr');
    row.style.backgroundColor = 'var(--vscode-editor-inactiveSelectionBackground)';
    row.style.fontWeight = 'bold';

    const cells = [
        { content: provider.displayName },
        { content: provider.totalInputTokensFormatted },
        { content: provider.totalCacheReadTokensFormatted },
        { content: provider.totalOutputTokensFormatted },
        { content: provider.totalTokensFormatted },
        { content: provider.totalRequests }
    ];

    cells.forEach(cellData => {
        const td = document.createElement('td');
        td.textContent = cellData.content;
        row.appendChild(td);
    });

    return row;
}

/**
 * 创建模型行
 * @param {Object} model - 模型数据
 * @returns {HTMLElement} 表格行元素
 */
function createModelRow(model) {
    const row = document.createElement('tr');
    row.style.opacity = '0.85';

    const cells = [
        { content: `└─ ${model.modelName}`, indent: true },
        { content: model.totalInputTokensFormatted },
        { content: model.totalCacheReadTokensFormatted },
        { content: model.totalOutputTokensFormatted },
        { content: model.totalTokensFormatted },
        { content: model.totalRequests }
    ];

    cells.forEach(cellData => {
        const td = document.createElement('td');
        if (cellData.indent) {
            td.style.paddingLeft = '24px';
        }
        td.textContent = cellData.content;
        row.appendChild(td);
    });

    return row;
}

/**
 * 创建各小时用量部分
 * @param {Array} hourlyStats - 小时统计数据
 * @returns {HTMLElement} 小时统计元素
 */
function createHourlySection(hourlyStats) {
    const section = document.createElement('div');

    const h2 = document.createElement('h2');
    h2.textContent = '各小时用量';
    section.appendChild(h2);

    const table = createHourlyTable(hourlyStats);
    section.appendChild(table);

    return section;
}

/**
 * 创建各小时用量表格
 * @param {Array} hourlyStats - 小时统计数据
 * @returns {HTMLElement} 表格元素
 */
function createHourlyTable(hourlyStats) {
    if (hourlyStats.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-message';
        empty.textContent = '暂无数据';
        return empty;
    }

    const table = document.createElement('table');

    // 创建表头
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const headers = ['时间', '输入', '缓存', '输出', '消耗量', '请求数'];
    headers.forEach(headerText => {
        const th = document.createElement('th');
        th.textContent = headerText;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    // 创建表体
    const tbody = document.createElement('tbody');
    hourlyStats.forEach(hourStat => {
        const row = document.createElement('tr');

        const cells = [
            { content: hourStat.time, bold: true },
            { content: hourStat.totalInputFormatted },
            { content: hourStat.totalCacheReadFormatted },
            { content: hourStat.totalOutputFormatted },
            { content: hourStat.totalFormatted, bold: true },
            { content: hourStat.totalRequests }
        ];

        cells.forEach(cellData => {
            const td = document.createElement('td');
            if (cellData.bold) {
                const strong = document.createElement('strong');
                strong.textContent = cellData.content;
                td.appendChild(strong);
            } else {
                td.textContent = cellData.content;
            }
            row.appendChild(td);
        });

        tbody.appendChild(row);
    });

    table.appendChild(thead);
    table.appendChild(tbody);

    return table;
}

/**
 * 创建记录表格(带分页)
 * @param {Array} records - 记录列表
 * @param {number} page - 当前页码
 * @returns {HTMLElement} 记录表格容器
 */
function createRecordsTable(records, page) {
    const container = document.createElement('div');

    if (records.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-message';
        empty.textContent = '暂无记录';
        container.appendChild(empty);
        return container;
    }

    // 分页设置
    const pageSize = 20;
    const totalRecords = records.length;
    const totalPages = Math.ceil(totalRecords / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, totalRecords);
    const pageRecords = records.slice(startIndex, endIndex);

    // 上方分页控制器
    const topPagination = createPagination(page, totalPages, totalRecords, startIndex, endIndex);
    container.appendChild(topPagination);

    // 创建表格
    const table = document.createElement('table');

    // 创建表头
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const headers = ['时间', '提供商', '模型', '输入', '缓存', '输出', '状态'];
    headers.forEach(headerText => {
        const th = document.createElement('th');
        th.textContent = headerText;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    // 创建表体
    const tbody = document.createElement('tbody');
    pageRecords.forEach(record => {
        const row = createRecordRow(record);
        tbody.appendChild(row);
    });

    table.appendChild(thead);
    table.appendChild(tbody);
    container.appendChild(table);

    // 下方分页控制器
    const bottomPagination = createPagination(page, totalPages, totalRecords, startIndex, endIndex);
    container.appendChild(bottomPagination);

    return container;
}

/**
 * 创建记录行
 * @param {Object} record - 记录数据
 * @returns {HTMLElement} 表格行元素
 */
function createRecordRow(record) {
    const row = document.createElement('tr');

    const cells = [
        { content: record.time },
        { content: record.providerName },
        { content: record.modelName },
        { content: record.inputDisplay },
        { content: record.cacheDisplay },
        { content: record.outputDisplay },
        { content: record.statusText, className: record.statusClass }
    ];

    cells.forEach(cellData => {
        const td = document.createElement('td');
        if (cellData.className) {
            td.className = cellData.className;
        }
        td.textContent = cellData.content;
        row.appendChild(td);
    });

    return row;
}

/**
 * 创建分页控制器
 * @param {number} currentPage - 当前页
 * @param {number} totalPages - 总页数
 * @param {number} totalRecords - 总记录数
 * @param {number} startIndex - 起始索引
 * @param {number} endIndex - 结束索引
 * @returns {HTMLElement} 分页元素
 */
function createPagination(currentPage, totalPages, totalRecords, startIndex, endIndex) {
    const pagination = document.createElement('div');
    pagination.className = 'pagination';

    if (totalPages <= 1) {
        const info = document.createElement('div');
        info.className = 'pagination-info';
        info.textContent = `共 ${totalRecords} 条记录`;
        pagination.appendChild(info);
        return pagination;
    }

    // 计算要显示的页码范围
    const maxPagesToShow = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxPagesToShow / 2));
    let endPage = Math.min(totalPages, startPage + maxPagesToShow - 1);

    // 调整起始页
    if (endPage - startPage < maxPagesToShow - 1) {
        startPage = Math.max(1, endPage - maxPagesToShow + 1);
    }

    // 上一页按钮
    const prevButton = document.createElement('button');
    prevButton.textContent = '上一页';
    prevButton.onclick = () => changePage(currentPage - 1);
    if (currentPage === 1) {
        prevButton.disabled = true;
    }
    pagination.appendChild(prevButton);

    // 第一页
    if (startPage > 1) {
        const firstButton = document.createElement('button');
        firstButton.className = `page-number ${currentPage === 1 ? 'active' : ''}`;
        firstButton.textContent = '1';
        firstButton.onclick = () => changePage(1);
        pagination.appendChild(firstButton);

        if (startPage > 2) {
            const ellipsis = document.createElement('span');
            ellipsis.textContent = '...';
            pagination.appendChild(ellipsis);
        }
    }

    // 页码按钮
    for (let i = startPage; i <= endPage; i++) {
        const pageButton = document.createElement('button');
        pageButton.className = `page-number ${i === currentPage ? 'active' : ''}`;
        pageButton.textContent = i.toString();
        const pageNum = i;
        pageButton.onclick = () => changePage(pageNum);
        pagination.appendChild(pageButton);
    }

    // 最后一页
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            const ellipsis = document.createElement('span');
            ellipsis.textContent = '...';
            pagination.appendChild(ellipsis);
        }

        const lastButton = document.createElement('button');
        lastButton.className = `page-number ${currentPage === totalPages ? 'active' : ''}`;
        lastButton.textContent = totalPages.toString();
        lastButton.onclick = () => changePage(totalPages);
        pagination.appendChild(lastButton);
    }

    // 下一页按钮
    const nextButton = document.createElement('button');
    nextButton.textContent = '下一页';
    nextButton.onclick = () => changePage(currentPage + 1);
    if (currentPage === totalPages) {
        nextButton.disabled = true;
    }
    pagination.appendChild(nextButton);

    // 显示当前记录范围
    const info = document.createElement('span');
    info.className = 'pagination-info';
    info.textContent = `${startIndex + 1}-${endIndex} / ${totalRecords}`;
    pagination.appendChild(info);

    return pagination;
}


/**
 * 绑定事件监听器
 */
function bindEventListeners() {
    // 监听来自 VSCode 的消息
    window.addEventListener('message', event => {
        const message = event.data;

        switch (message.command) {
            case 'appendDates':
                handleAppendDates(message);
                break;
            case 'updateDateDetails':
                handleUpdateDateDetails(message);
                hideLoading();
                break;
            case 'updatePageRecords':
                handleUpdatePageRecords(message);
                hideLoading();
                break;
            case 'updateDateList':
                handleUpdateDateList(message);
                break;
        }
    });

    // 页面加载后,恢复记录区域滚动位置
    window.addEventListener('DOMContentLoaded', () => {
        const recordsSection = document.getElementById('records-section');
        if (recordsSection && currentPage > 1) {
            setTimeout(() => {
                const contentContainer = document.querySelector('.content');
                const savedOffset = sessionStorage.getItem('recordsScrollOffset');
                if (savedOffset) {
                    contentContainer.scrollTop = recordsSection.offsetTop - parseInt(savedOffset);
                    sessionStorage.removeItem('recordsScrollOffset');
                } else {
                    contentContainer.scrollTop = recordsSection.offsetTop - 20;
                }
            }, 50);
        }
    });
}

/**
 * 处理追加日期消息
 * @param {Object} message - 消息对象
 */
function handleAppendDates(message) {
    const dateList = document.querySelector('.date-list');
    const loadMoreContainer = document.querySelector('.load-more-container');

    if (dateList && loadMoreContainer) {
        // 移除旧的"加载更多"按钮
        loadMoreContainer.remove();

        // 插入新的日期项
        message.dates.forEach(dateInfo => {
            const dateItem = document.createElement('div');
            dateItem.className = 'date-item';
            dateItem.dataset.date = dateInfo.date;

            const contentDiv = document.createElement('div');
            contentDiv.onclick = () => selectDate(dateInfo.date);

            const header = document.createElement('div');
            header.className = 'date-item-header';

            const title = document.createElement('div');
            title.className = `date-item-title ${dateInfo.isToday ? 'today' : ''}`;
            title.textContent = dateInfo.displayDate;

            header.appendChild(title);

            const stats = document.createElement('div');
            stats.className = 'date-item-stats';
            stats.textContent = `请求: ${dateInfo.totalRequests} | Token: ${dateInfo.totalTokens}`;

            contentDiv.appendChild(header);
            contentDiv.appendChild(stats);
            dateItem.appendChild(contentDiv);
            dateList.appendChild(dateItem);
        });

        // 更新当前限制
        currentDatesLimit = message.newLimit;

        // 如果还有更多数据,添加新的"加载更多"按钮
        if (message.remainingCount > 0) {
            const newLoadMoreContainer = createLoadMoreButton(message.newLimit + message.remainingCount);
            dateList.appendChild(newLoadMoreContainer);
        }
    }
}

/**
 * 处理更新日期详情消息
 * @param {Object} message - 消息对象
 */
function handleUpdateDateDetails(message) {
    // 更新当前日期
    currentDate = message.date;
    currentPage = message.currentPage;

    // 更新标题
    const title = document.getElementById('details-title');
    if (title) {
        title.textContent = `${message.date} 使用详情`;
    }

    // 更新详情内容
    const detailsContent = document.getElementById('details-content');
    if (detailsContent) {
        detailsContent.innerHTML = '';

        if (message.providers.length > 0) {
            // 创建提供商统计
            const providersSection = createProvidersSection(message.providers);
            detailsContent.appendChild(providersSection);

            // 创建各小时用量
            const hourlySection = createHourlySection(message.hourlyStats);
            detailsContent.appendChild(hourlySection);
        } else {
            // 空消息
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'empty-message';
            emptyMessage.innerHTML = `<p>💡 ${message.date} 暂无 Token 消耗记录</p>`;
            detailsContent.appendChild(emptyMessage);
        }
    }

    // 更新记录容器
    const recordsContainer = document.getElementById('records-container');
    if (recordsContainer) {
        recordsContainer.innerHTML = '';
        const recordsTable = createRecordsTable(message.records, message.currentPage);
        recordsContainer.appendChild(recordsTable);
    }

    // 更新日期列表选中状态（包括添加删除按钮）
    updateDateSelection(message.date);
}

/**
 * 处理更新分页记录消息
 * @param {Object} message - 消息对象
 */
function handleUpdatePageRecords(message) {
    currentPage = message.page;

    // 保存当前的记录区域的滚动偏移
    const recordsSection = document.getElementById('records-section');
    if (recordsSection) {
        const contentContainer = document.querySelector('.content');
        const offset = recordsSection.offsetTop - contentContainer.scrollTop;
        sessionStorage.setItem('recordsScrollOffset', offset.toString());
    }

    // 更新记录容器
    const recordsContainer = document.getElementById('records-container');
    if (recordsContainer) {
        recordsContainer.innerHTML = '';
        const recordsTable = createRecordsTable(message.records, message.page);
        recordsContainer.appendChild(recordsTable);
    }

    // 恢复滚动位置
    setTimeout(() => {
        if (recordsSection) {
            const contentContainer = document.querySelector('.content');
            const savedOffset = sessionStorage.getItem('recordsScrollOffset');
            if (savedOffset) {
                contentContainer.scrollTop = recordsSection.offsetTop - parseInt(savedOffset);
                sessionStorage.removeItem('recordsScrollOffset');
            }
        }
    }, 50);
}

/**
 * 处理更新日期列表消息（只更新统计数字，不改变选中状态）
 * @param {Object} message - 消息对象
 */
function handleUpdateDateList(message) {
    const dateList = document.querySelector('.date-list');
    if (!dateList) {
        return;
    }

    // 更新每个日期项的统计数字
    message.dateList.forEach(dateInfo => {
        // 查找对应的日期项
        const dateItems = dateList.querySelectorAll('.date-item');
        let found = false;

        dateItems.forEach(item => {
            const titleElement = item.querySelector('.date-item-title');
            if (titleElement) {
                const dateMatch = titleElement.textContent.match(/\d{4}-\d{2}-\d{2}/);
                if (dateMatch && dateMatch[0] === dateInfo.date) {
                    // 找到匹配的日期项，更新统计数字
                    const statsElement = item.querySelector('.date-item-stats');
                    if (statsElement) {
                        statsElement.textContent = `请求: ${dateInfo.total_requests} | Token: ${dateInfo.totalTokensFormatted}`;
                    }
                    found = true;
                }
            }
        });

        // 如果是今天且没有找到，则创建并插入到列表顶部
        if (!found && dateInfo.isToday) {
            const displayDate = `今日 (${dateInfo.date})`;
            const newDateItem = document.createElement('div');
            newDateItem.className = 'date-item';
            newDateItem.dataset.date = dateInfo.date;

            const contentDiv = document.createElement('div');
            contentDiv.onclick = () => selectDate(dateInfo.date);

            const header = document.createElement('div');
            header.className = 'date-item-header';

            const title = document.createElement('div');
            title.className = 'date-item-title today';
            title.textContent = displayDate;

            header.appendChild(title);

            const stats = document.createElement('div');
            stats.className = 'date-item-stats';
            stats.textContent = `请求: ${dateInfo.total_requests} | Token: ${dateInfo.totalTokensFormatted}`;

            contentDiv.appendChild(header);
            contentDiv.appendChild(stats);
            newDateItem.appendChild(contentDiv);

            // 插入到列表顶部（在第一个 date-item 之前）
            const firstDateItem = dateList.querySelector('.date-item');
            if (firstDateItem) {
                dateList.insertBefore(newDateItem, firstDateItem);
            } else {
                // 如果列表为空，直接添加
                dateList.appendChild(newDateItem);
            }
        }
    });
}

/**
 * 更新日期列表的选中状态
 * @param {string} selectedDate - 选中的日期
 */
function updateDateSelection(selectedDate) {
    const dateItems = document.querySelectorAll('.date-item');
    dateItems.forEach(item => {
        const itemDate = item.dataset.date;
        const isSelected = itemDate === selectedDate;

        // 更新选中状态
        if (isSelected) {
            item.classList.add('selected');
        } else {
            item.classList.remove('selected');
        }
    });
}

/**
 * 选择日期
 * @param {string} date - 日期
 */
function selectDate(date) {
    isPageChange = false;
    showLoading();
    vscode.postMessage({ command: 'selectDate', date: date });
}

/**
 * 打开存储目录
 */
function openStorageDir() {
    vscode.postMessage({ command: 'openStorageDir' });
}

/**
 * 加载更多日期
 */
function loadMoreDates() {
    vscode.postMessage({ command: 'loadMoreDates', currentLimit: currentDatesLimit });
}

/**
 * 切换页码
 * @param {number} page - 页码
 */
function changePage(page) {
    isPageChange = true;
    showLoading();
    vscode.postMessage({ command: 'changePage', date: currentDate, page: page });
}

/**
 * 创建加载遮罩
 */
function createLoadingOverlay() {
    loadingOverlay = document.createElement('div');
    loadingOverlay.className = 'loading-overlay';

    const content = document.createElement('div');
    content.className = 'loading-content';

    const spinner = document.createElement('div');
    spinner.className = 'loading-spinner';

    const text = document.createElement('div');
    text.className = 'loading-text';
    text.textContent = '加载中...';

    content.appendChild(spinner);
    content.appendChild(text);
    loadingOverlay.appendChild(content);
    document.body.appendChild(loadingOverlay);
}

/**
 * 显示加载遮罩
 */
function showLoading() {
    if (loadingOverlay) {
        loadingOverlay.classList.add('visible');
    }
}

/**
 * 隐藏加载遮罩
 */
function hideLoading() {
    if (loadingOverlay) {
        loadingOverlay.classList.remove('visible');
    }
}
