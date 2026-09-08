/*---------------------------------------------------------------------------------------------
 *  工具调用 id 工具
 *--------------------------------------------------------------------------------------------*/

/** 工具调用 id 去重：首次出现保持原样，重复时改写为递增 __gcmpDup{N} 后缀 */
export function uniquifyCallId(usedCallIds: Set<string>, callId: string): string {
    if (!usedCallIds.has(callId)) {
        usedCallIds.add(callId);
        return callId;
    }
    let n = 2;
    let candidate = `${callId}__gcmpDup${n}`;
    while (usedCallIds.has(candidate)) {
        candidate = `${callId}__gcmpDup${++n}`;
    }
    usedCallIds.add(candidate);
    return candidate;
}
