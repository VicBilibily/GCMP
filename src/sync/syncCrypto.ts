/**
 * Gist 同步加密模块
 * 负责 AES-256-GCM 加解密与 scrypt 密钥派生
 */
import * as crypto from 'crypto';

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
 * @param githubId GitHub 用户数字 ID
 * @param salt 盐值
 * @param passphrase 可选的自定义口令
 * @returns 派生出的密钥，失败返回 undefined
 */
export function deriveKey(githubId: string, salt: Buffer, passphrase: string | undefined): Buffer | undefined {
    const secret = passphrase ? `${githubId}:${ENCRYPTION_PEPPER}:${passphrase}` : `${githubId}:${ENCRYPTION_PEPPER}`;

    try {
        return crypto.scryptSync(secret, salt, KEY_LENGTH, {
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
export function encrypt(githubId: string, plaintext: string, passphrase: string | undefined): string | undefined {
    const salt = crypto.randomBytes(32);
    const key = deriveKey(githubId, salt, passphrase);
    if (!key) {
        return undefined;
    }
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
 * 解密密文数据包
 * @param githubId GitHub 用户数字 ID
 * @param encryptedPayload JSON 序列化后的加密数据包
 * @param passphrase 可选的自定义口令
 * @returns 明文，解密失败返回 undefined
 */
export function decrypt(
    githubId: string,
    encryptedPayload: string,
    passphrase: string | undefined
): string | undefined {
    let payload: EncryptedPayload;
    try {
        payload = JSON.parse(encryptedPayload) as EncryptedPayload;
    } catch {
        return undefined;
    }

    if (payload.algorithm !== 'aes-256-gcm' || payload.kdf !== 'scrypt') {
        return undefined;
    }

    const salt = Buffer.from(payload.salt, 'hex');
    const key = deriveKey(githubId, salt, passphrase);
    if (!key) {
        return undefined;
    }
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
 * 使用指定口令解密密文数据包（不依赖已存储的口令）
 * 用于口令验证：尝试用用户输入的口令解密，判断口令是否正确
 * @param githubId GitHub 用户数字 ID
 * @param encryptedPayload JSON 序列化后的加密数据包
 * @param passphrase 要尝试的口令
 * @returns 明文，解密失败返回 undefined
 */
export function decryptWithPassphrase(
    githubId: string,
    encryptedPayload: string,
    passphrase: string
): string | undefined {
    return decrypt(githubId, encryptedPayload, passphrase);
}
