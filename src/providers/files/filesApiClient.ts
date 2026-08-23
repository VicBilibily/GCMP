/*---------------------------------------------------------------------------------------------
 *  Files API 上传客户端（OpenAI 兼容，DeepSeek 等支持 Files API 的提供商通用）
 *  独立实现 multipart/form-data 上传（不依赖任何 SDK 内置 files API）。
 *  POST 完整上传地址（默认 {对话baseUrl}/files），purpose=user_data + expires_after，返回 file_id 与过期时间。
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'node:crypto';
import { Logger } from '../../utils/runtime/logger';

export interface UploadedFile {
    fileId: string;
    /** 过期时间（Unix 秒） */
    expiresAt: number;
}

export interface FilesApiClientOptions {
    apiKey: string;
    /** 完整上传请求地址（已解析，含 /files 路径） */
    uploadUrl: string;
    /** 代理感知的 fetch（ConfigManager.createProxyAwareFetch） */
    fetchFn: typeof fetch;
}

/** 手动序列化 multipart/form-data，避免 fetch 实现不识别全局 FormData 导致 boundary 丢失 */
function buildMultipartBody(
    fileBytes: Uint8Array,
    mimeType: string,
    ext: string,
    ttlSeconds: number
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
    const boundary = `----gcmp${randomBytes(16).toString('hex')}`;
    const encoder = new TextEncoder();
    const head = encoder.encode(
        `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="image.${ext}"\r\n` +
            `Content-Type: ${mimeType}\r\n\r\n`
    );
    const tail = encoder.encode(
        `\r\n--${boundary}\r\n` +
            'Content-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n' +
            `--${boundary}\r\n` +
            'Content-Disposition: form-data; name="expires_after[anchor]"\r\n\r\ncreated_at\r\n' +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="expires_after[seconds]"\r\n\r\n${ttlSeconds}\r\n` +
            `--${boundary}--\r\n`
    );
    const body = new Uint8Array(head.length + fileBytes.length + tail.length);
    body.set(head, 0);
    body.set(fileBytes, head.length);
    body.set(tail, head.length + fileBytes.length);
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export class FilesApiClient {
    /** 上传目的地指纹（uploadUrl+apiKey 哈希），供缓存按 provider/账号/端点隔离，不落盘密钥 */
    readonly cacheScope: string;

    constructor(private readonly options: FilesApiClientOptions) {
        this.cacheScope = createHash('sha256')
            .update(`${options.uploadUrl}\n${options.apiKey}`)
            .digest('hex')
            .slice(0, 16);
    }

    /**
     * 上传图片到 Files API，返回 file_id 与服务端过期时间。
     */
    async uploadImage(fileBytes: Uint8Array, mimeType: string, ttlSeconds: number): Promise<UploadedFile> {
        const ext = mimeType.split('/')[1] || 'png';
        const { body, contentType } = buildMultipartBody(fileBytes, mimeType, ext, ttlSeconds);

        const response = await this.options.fetchFn(this.options.uploadUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.options.apiKey}`,
                'Content-Type': contentType
            },
            body
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Files API upload failed: HTTP ${response.status} ${text.slice(0, 200)}`);
        }
        const data = (await response.json()) as { id?: string; expires_at?: number };
        if (!data.id) {
            throw new Error('Files API upload returned no file id');
        }
        // 服务端 expires_at 为准，缺失时回退客户端计算
        const expiresAt = data.expires_at ?? Math.floor(Date.now() / 1000) + ttlSeconds;
        Logger.debug(`[FilesAPI] Uploaded image: fileId=${data.id}, expiresAt=${expiresAt}, bytes=${fileBytes.length}`);
        return { fileId: data.id, expiresAt };
    }
}
