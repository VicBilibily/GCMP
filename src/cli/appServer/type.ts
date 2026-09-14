/*---------------------------------------------------------------------------------------------
 *  Codex App Server 传输层类型
 *--------------------------------------------------------------------------------------------*/

/** gcmp.providerOverrides.codex.appServer 子配置 */
export interface CodexAppServerConfig {
    /** codex 可执行文件路径；空/未设置 = PATH 自动探测 */
    codexBinary?: string;
    /** 空闲回收分钟数；0 = 常驻 */
    idleShutdownMinutes?: number;
    /** 会话映射模式：ephemeral（默认，每请求独立 thread）| persistent（sessionId↔threadId 增量） */
    threadMode?: 'ephemeral' | 'persistent';
}
