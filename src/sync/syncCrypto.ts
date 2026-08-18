/**
 * Gist 同步加密模块
 * 负责 AES-256-GCM 加解密与 scrypt 密钥派生
 */
import * as crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt) as (
    password: string,
    salt: Buffer,
    keylen: number,
    options: crypto.ScryptOptions
) => Promise<Buffer>;

/** 批量加密器：dispose 时清零内存中的派生密钥 */
export type BatchEncryptor = ((plaintext: string) => string) & { dispose(): void };

/** 批量解密器：按 salt 惰性派生密钥；dispose 时清零全部缓存密钥 */
export type BatchDecryptor = ((encryptedPayload: string) => Promise<string | undefined>) & { dispose(): void };

/**
 * scrypt 参数
 */
export interface ScryptParams {
    N: number;
    r: number;
    p: number;
}

/**
 * 加密后的密钥数据包结构
 */
export interface EncryptedPayload {
    /** 加密算法标识 */
    algorithm: 'aes-256-gcm';
    /** 密钥派生函数类型 */
    kdf: 'scrypt';
    /** 密钥派生函数参数 */
    kdfParams: ScryptParams;
    /** 盐值 (hex) */
    salt: string;
    /** 初始化向量 (hex) */
    iv: string;
    /** 认证标签 (hex) */
    tag: string;
    /** 密文 (hex) */
    data: string;
}

function isHexString(value: unknown, expectedBytes?: number, allowEmpty = false): value is string {
    if (typeof value !== 'string') {
        return false;
    }
    if (!allowEmpty && value.length === 0) {
        return false;
    }
    if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
        return false;
    }
    return expectedBytes === undefined || value.length === expectedBytes * 2;
}

/** 用于派生加密密钥的固定 pepper */
const ENCRYPTION_PEPPER = 'gcmp-sync-aes256-v1';

/** 加密密钥长度 (AES-256) */
const KEY_LENGTH = 32;

/** 默认 scrypt 参数 */
const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

/**
 * 判断加密数据包是否使用当前推荐的 KDF
 * 用于上传时统一迁移旧格式
 */
export function isCurrentKdf(encryptedPayload: string): boolean {
    let payload: EncryptedPayload;
    try {
        payload = JSON.parse(encryptedPayload) as EncryptedPayload;
    } catch {
        return false;
    }
    return payload.algorithm === 'aes-256-gcm' && payload.kdf === 'scrypt';
}

/**
 * 从 GitHub 用户 ID 派生加密密钥（不依赖 PAT 内容）
 * 如果设置了自定义口令，口令也会参与密钥派生，提供额外保护
 * 使用异步 scrypt，批量派生时不阻塞事件循环
 * @param githubId GitHub 用户数字 ID
 * @param salt 盐值
 * @param passphrase 可选的自定义口令
 * @returns 派生出的密钥，失败返回 undefined
 */
export async function deriveKey(
    githubId: string,
    salt: Buffer,
    passphrase: string | undefined
): Promise<Buffer | undefined> {
    const secret = passphrase ? `${githubId}:${ENCRYPTION_PEPPER}:${passphrase}` : `${githubId}:${ENCRYPTION_PEPPER}`;

    try {
        return await scryptAsync(secret, salt, KEY_LENGTH, {
            N: DEFAULT_SCRYPT_PARAMS.N,
            r: DEFAULT_SCRYPT_PARAMS.r,
            p: DEFAULT_SCRYPT_PARAMS.p,
            maxmem: 128 * 1024 * 1024
        });
    } catch {
        return undefined;
    }
}

/**
 * 加密明文数据
 * @param githubId GitHub 用户数字 ID
 * @param plaintext 明文
 * @param passphrase 可选的自定义口令
 * @returns 加密后的数据包（JSON 序列化后的字符串），加密失败返回 undefined
 */
export async function encrypt(
    githubId: string,
    plaintext: string,
    passphrase: string | undefined
): Promise<string | undefined> {
    const salt = crypto.randomBytes(32);
    const key = await deriveKey(githubId, salt, passphrase);
    if (!key) {
        return undefined;
    }
    try {
        return encryptWithKey(plaintext, key, salt);
    } finally {
        key.fill(0);
    }
}

/** 用已派生的密钥加密单条明文（IV 逐条随机生成） */
function encryptWithKey(plaintext: string, key: Buffer, salt: Buffer): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const payload: EncryptedPayload = {
        algorithm: 'aes-256-gcm',
        kdf: 'scrypt',
        kdfParams: DEFAULT_SCRYPT_PARAMS,
        salt: salt.toString('hex'),
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
        data: encrypted.toString('hex')
    };

    return JSON.stringify(payload);
}

/**
 * 创建批量加密器：同一批明文共享 salt，密钥仅派生一次
 * GCM 安全性依赖 key+IV 唯一（IV 仍逐条随机生成），共享 salt 不降低安全性
 * 使用完毕后应调用 dispose() 清零内存中的派生密钥
 * @param githubId GitHub 用户数字 ID
 * @param passphrase 可选的自定义口令
 * @returns 加密函数；密钥派生失败返回 undefined
 */
export async function createBatchEncryptor(
    githubId: string,
    passphrase: string | undefined
): Promise<BatchEncryptor | undefined> {
    const salt = crypto.randomBytes(32);
    const key = await deriveKey(githubId, salt, passphrase);
    if (!key) {
        return undefined;
    }
    let disposed = false;
    const encryptor = ((plaintext: string) => {
        if (disposed) {
            throw new Error('BatchEncryptor has been disposed');
        }
        return encryptWithKey(plaintext, key, salt);
    }) as BatchEncryptor;
    encryptor.dispose = () => {
        disposed = true;
        key.fill(0);
    };
    return encryptor;
}

/** 解析并校验加密数据包结构 */
function parsePayload(encryptedPayload: string): EncryptedPayload | undefined {
    let payload: EncryptedPayload;
    try {
        payload = JSON.parse(encryptedPayload) as EncryptedPayload;
    } catch {
        return undefined;
    }

    if (
        !payload ||
        typeof payload !== 'object' ||
        payload.algorithm !== 'aes-256-gcm' ||
        payload.kdf !== 'scrypt' ||
        !isHexString(payload.salt, 32) ||
        !isHexString(payload.iv, 16) ||
        !isHexString(payload.tag, 16) ||
        !isHexString(payload.data, undefined, true)
    ) {
        return undefined;
    }
    return payload;
}

/** 用已派生的密钥解密数据包；认证失败返回 undefined */
function decryptPayload(payload: EncryptedPayload, key: Buffer): string | undefined {
    const iv = Buffer.from(payload.iv, 'hex');
    const tag = Buffer.from(payload.tag, 'hex');
    const encrypted = Buffer.from(payload.data, 'hex');

    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return decrypted.toString('utf8');
    } catch {
        return undefined;
    }
}

/**
 * 解密密文数据包
 * @param githubId GitHub 用户数字 ID
 * @param encryptedPayload JSON 序列化后的加密数据包
 * @param passphrase 可选的自定义口令
 * @returns 明文，解密失败返回 undefined
 */
export async function decrypt(
    githubId: string,
    encryptedPayload: string,
    passphrase: string | undefined
): Promise<string | undefined> {
    const payload = parsePayload(encryptedPayload);
    if (!payload) {
        return undefined;
    }

    const key = await deriveKey(githubId, Buffer.from(payload.salt, 'hex'), passphrase);
    if (!key) {
        return undefined;
    }
    try {
        return decryptPayload(payload, key);
    } finally {
        key.fill(0);
    }
}

/**
 * 创建批量解密器：按 salt 缓存派生密钥，同一 salt 仅派生一次
 * 兼容逐条独立 salt 的数据（每个不同 salt 各自派生一次）
 * 使用完毕后应调用 dispose() 清零缓存的派生密钥
 * @param githubId GitHub 用户数字 ID
 * @param passphrase 可选的自定义口令
 */
export function createBatchDecryptor(githubId: string, passphrase: string | undefined): BatchDecryptor {
    const keyCache = new Map<string, Buffer>();
    const decryptor = (async (encryptedPayload: string) => {
        const payload = parsePayload(encryptedPayload);
        if (!payload) {
            return undefined;
        }
        let key = keyCache.get(payload.salt);
        if (!key) {
            const derived = await deriveKey(githubId, Buffer.from(payload.salt, 'hex'), passphrase);
            if (!derived) {
                return undefined;
            }
            key = derived;
            keyCache.set(payload.salt, key);
        }
        return decryptPayload(payload, key);
    }) as BatchDecryptor;
    decryptor.dispose = () => {
        for (const cachedKey of keyCache.values()) {
            cachedKey.fill(0);
        }
        keyCache.clear();
    };
    return decryptor;
}

/**
 * 使用指定口令解密密文数据包（不依赖已存储的口令）
 * 用于口令验证：尝试用用户输入的口令解密，判断口令是否正确
 * @param githubId GitHub 用户数字 ID
 * @param encryptedPayload JSON 序列化后的加密数据包
 * @param passphrase 要尝试的口令
 * @returns 明文，解密失败返回 undefined
 */
export async function decryptWithPassphrase(
    githubId: string,
    encryptedPayload: string,
    passphrase: string
): Promise<string | undefined> {
    return decrypt(githubId, encryptedPayload, passphrase);
}
