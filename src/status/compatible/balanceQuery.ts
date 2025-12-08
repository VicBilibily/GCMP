/*---------------------------------------------------------------------------------------------
 *  兼容提供商余额查询接口和类型定义
 *--------------------------------------------------------------------------------------------*/

/**
 * 余额查询结果
 */
export interface BalanceQueryResult {
    /** 已支付余额 */
    paid?: number;
    /** 赠送余额 */
    granted?: number;
    /** 可用余额 */
    balance: number;
    /** 货币符号(CNY/USD) */
    currency: string;
}

/**
 * 余额查询器接口
 */
export interface IBalanceQuery {
    /**
     * 查询提供商余额
     * @param providerId 提供商标识符
     * @returns 余额查询结果
     */
    queryBalance(providerId: string): Promise<BalanceQueryResult>;
}
