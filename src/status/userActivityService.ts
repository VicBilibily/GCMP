import * as vscode from 'vscode';
import { StatusLogger } from '../utils/statusLogger';

/**
 * 用户活跃信息结构
 */
interface UserActivityInfo {
    lastActiveTime: number; // 最后一次活跃的时间戳
    instanceId: string; // 最后活跃的实例ID
    recentActivityCount: number; // 最近活跃次数（用于评估活跃度）
    lastActivityType?: ActivityType; // 最后一次活跃的操作类型
}

/**
 * 用户操作类型枚举
 */
type ActivityType = 'windowFocus' | 'editorChange' | 'textEdit' | 'textSelection' | 'terminalChange';

/**
 * 不同操作类型的节流配置（毫秒）
 */
const ACTIVITY_THROTTLE_CONFIG: Record<ActivityType, number> = {
    windowFocus: 5000, // 窗口聚焦变化：5秒
    editorChange: 3000, // 编辑器切换：3秒
    textEdit: 5000, // 文本编辑：5秒
    textSelection: 2000, // 文本选择：2秒（最可靠的用户操作）
    terminalChange: 3000 // 终端切换：3秒
};

/**
 * 用户活跃状态检测服务（纯静态类）
 * 负责监听和记录用户在 VS Code 中的活跃状态
 * 支持多实例共享活跃状态
 */
export class UserActivityService {
    private static readonly USER_ACTIVITY_KEY = 'gcmp.user.activity'; // 用户活跃状态存储键
    private static readonly ACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30分钟活跃超时
    private static readonly ACTIVITY_COUNT_WINDOW = 5 * 60 * 1000; // 活跃次数统计窗口：5分钟
    private static readonly CACHE_VALIDITY = 5000; // 缓存有效期：5秒

    // 静态成员变量
    private static instanceId: string;
    private static context: vscode.ExtensionContext | undefined;
    private static activityDisposables: vscode.Disposable[] = []; // 活跃状态监听器
    private static lastRecordedActivityByType = new Map<ActivityType, number>(); // 按类型记录的上次活跃时间
    private static cachedActivityInfo: UserActivityInfo | null = null; // 内存缓存
    private static lastCacheUpdate = 0; // 缓存更新时间
    private static initialized = false;

    /**
     * 私有构造函数 - 防止实例化
     */
    private constructor() {
        throw new Error('UserActivityService is a static class and cannot be instantiated');
    }

    /**
     * 初始化活跃检测服务
     * @param context VS Code 扩展上下文
     * @param instanceId 当前实例ID（由调用方提供）
     */
    public static initialize(context: vscode.ExtensionContext, instanceId: string): void {
        if (this.initialized) {
            return;
        }

        this.context = context;
        this.instanceId = instanceId;

        // 注册用户活跃状态监听
        this.registerActivityListeners();

        this.initialized = true;
        StatusLogger.debug('[UserActivityService] 用户活跃检测服务已初始化');
    }

    /**
     * 停止活跃检测服务
     */
    public static stop(): void {
        // 清理活跃状态监听器
        this.activityDisposables.forEach(d => d.dispose());
        this.activityDisposables = [];

        // 清理缓存和状态
        this.cachedActivityInfo = null;
        this.lastCacheUpdate = 0;
        this.lastRecordedActivityByType.clear();

        this.initialized = false;
        StatusLogger.debug('[UserActivityService] 用户活跃检测服务已停止');
    }

    /**
     * 注册用户活跃状态监听器
     * 仅监听用户真实操作，过滤掉自动操作或非用户实际操作
     */
    private static registerActivityListeners(): void {
        if (!this.context) {
            return;
        }

        // 监听窗口状态变化（仅用户主动聚焦窗口）
        this.activityDisposables.push(
            vscode.window.onDidChangeWindowState(state => {
                if (state.focused) {
                    this.recordUserActivity('windowFocus');
                }
            })
        );

        // 监听用户主动切换编辑器（过滤掉程序触发的切换）
        this.activityDisposables.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (vscode.window.state.focused && editor) {
                    const scheme = editor.document.uri.scheme;
                    if (scheme === 'file' || scheme === 'untitled') {
                        this.recordUserActivity('editorChange');
                    }
                }
            })
        );

        // 监听文档内容变化（仅用户编辑，过滤自动格式化等）
        this.activityDisposables.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.contentChanges.length === 0) {
                    return;
                }
                if (!vscode.window.state.focused) {
                    return;
                }
                const scheme = event.document.uri.scheme;
                if (scheme !== 'file' && scheme !== 'untitled') {
                    return;
                }
                const totalChanges = event.contentChanges.reduce((sum, c) => sum + c.text.length + c.rangeLength, 0);
                if (totalChanges > 1000) {
                    return;
                }
                this.recordUserActivity('textEdit');
            })
        );

        // 监听用户选择变化（光标移动、文本选择）- 这是最可靠的用户操作信号
        this.activityDisposables.push(
            vscode.window.onDidChangeTextEditorSelection(event => {
                if (!vscode.window.state.focused) {
                    return;
                }
                const scheme = event.textEditor.document.uri.scheme;
                if (scheme !== 'file' && scheme !== 'untitled') {
                    return;
                }
                if (
                    event.kind === vscode.TextEditorSelectionChangeKind.Keyboard ||
                    event.kind === vscode.TextEditorSelectionChangeKind.Mouse
                ) {
                    this.recordUserActivity('textSelection');
                }
            })
        );

        // 监听用户主动切换终端
        this.activityDisposables.push(
            vscode.window.onDidChangeActiveTerminal(terminal => {
                if (vscode.window.state.focused && terminal) {
                    this.recordUserActivity('terminalChange');
                }
            })
        );

        // 初始化时如果窗口已聚焦，记录一次
        if (vscode.window.state.focused) {
            this.recordUserActivity('windowFocus');
        }

        StatusLogger.debug('[UserActivityService] 用户活跃状态监听器已注册（仅监听用户真实操作）');
    }

    /**
     * 检查指定操作类型是否需要节流
     * @param activityType 操作类型
     * @returns true 如果需要节流（跳过记录），false 如果可以记录
     */
    private static shouldThrottle(activityType: ActivityType): boolean {
        const now = Date.now();
        const lastRecorded = this.lastRecordedActivityByType.get(activityType) || 0;
        const throttleInterval = ACTIVITY_THROTTLE_CONFIG[activityType];
        return now - lastRecorded < throttleInterval;
    }

    /**
     * 记录用户活跃状态到 globalState（带差异化节流）
     * 任意实例的活跃状态都会更新全局的最后活跃时间
     * 不同操作类型使用不同的节流间隔
     * @param activityType 触发活跃的操作类型
     */
    private static async recordUserActivity(activityType: ActivityType): Promise<void> {
        if (!this.context) {
            return;
        }

        // 差异化节流：根据操作类型决定是否记录
        if (this.shouldThrottle(activityType)) {
            return;
        }

        const now = Date.now();
        this.lastRecordedActivityByType.set(activityType, now);

        // 获取当前活跃信息，计算活跃次数
        const currentInfo = this.getCachedActivityInfo();
        let recentActivityCount = 1;

        if (
            currentInfo &&
            typeof currentInfo.recentActivityCount === 'number' &&
            !isNaN(currentInfo.recentActivityCount)
        ) {
            // 如果上次活跃在统计窗口内，累加次数；否则重置
            if (now - currentInfo.lastActiveTime < this.ACTIVITY_COUNT_WINDOW) {
                recentActivityCount = Math.min(currentInfo.recentActivityCount + 1, 100); // 上限100
            }
        }

        const activityInfo: UserActivityInfo = {
            lastActiveTime: now,
            instanceId: this.instanceId,
            recentActivityCount: recentActivityCount,
            lastActivityType: activityType
        };

        // 更新缓存
        this.cachedActivityInfo = activityInfo;
        this.lastCacheUpdate = now;

        await this.context.globalState.update(this.USER_ACTIVITY_KEY, activityInfo);
        StatusLogger.trace(
            `[UserActivityService] 记录用户活跃状态: type=${activityType}, count=${recentActivityCount}, time=${now}`
        );
    }

    /**
     * 获取缓存的活跃信息（减少 globalState 读取）
     */
    private static getCachedActivityInfo(): UserActivityInfo | null {
        const now = Date.now();

        // 检查缓存是否有效
        if (this.cachedActivityInfo && now - this.lastCacheUpdate < this.CACHE_VALIDITY) {
            return this.cachedActivityInfo;
        }

        // 缓存失效，从 globalState 读取
        if (!this.context) {
            return null;
        }

        const activityInfo = this.context.globalState.get<UserActivityInfo>(this.USER_ACTIVITY_KEY);
        if (activityInfo) {
            // 数据验证和修复：确保 recentActivityCount 是有效的数字
            const isValidCount =
                typeof activityInfo.recentActivityCount === 'number' &&
                activityInfo.recentActivityCount >= 0 &&
                !isNaN(activityInfo.recentActivityCount);

            const validatedInfo: UserActivityInfo = {
                lastActiveTime: activityInfo.lastActiveTime ?? Date.now(),
                instanceId: activityInfo.instanceId ?? '',
                recentActivityCount: isValidCount ? activityInfo.recentActivityCount : 0,
                lastActivityType: activityInfo.lastActivityType
            };
            this.cachedActivityInfo = validatedInfo;
            this.lastCacheUpdate = now;
            return validatedInfo;
        }
        return null;
    }

    /**
     * 检查用户是否在最近30分钟内活跃
     * @returns true 如果用户在30分钟内有活跃，false 如果超过30分钟无活跃
     */
    public static isUserActive(): boolean {
        const activityInfo = this.getCachedActivityInfo();
        if (!activityInfo) {
            // 没有活跃记录，认为不活跃
            return false;
        }

        const now = Date.now();
        const inactiveTime = now - activityInfo.lastActiveTime;
        const isActive = inactiveTime <= this.ACTIVITY_TIMEOUT;

        StatusLogger.trace(
            `[UserActivityService] 检查用户活跃状态: lastActive=${activityInfo.lastActiveTime}, ` +
                `inactiveTime=${inactiveTime}ms, activityCount=${activityInfo.recentActivityCount}, isActive=${isActive}`
        );

        return isActive;
    }

    /**
     * 获取用户最后活跃时间
     * @returns 最后活跃时间戳，如果没有记录则返回 undefined
     */
    public static getLastActiveTime(): number | undefined {
        const activityInfo = this.getCachedActivityInfo();
        return activityInfo?.lastActiveTime;
    }

    /**
     * 获取用户不活跃的时长（毫秒）
     * @returns 不活跃时长，如果没有记录则返回 Infinity
     */
    public static getInactiveTime(): number {
        const lastActiveTime = this.getLastActiveTime();
        if (lastActiveTime === undefined) {
            return Infinity;
        }
        return Date.now() - lastActiveTime;
    }
}
