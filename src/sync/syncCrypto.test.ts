import * as assert from 'node:assert';
import { test } from 'node:test';
import {
    createBatchDecryptor,
    createBatchEncryptor,
    decrypt,
    decryptWithPassphrase,
    deriveKey,
    encrypt,
    isCurrentKdf
} from './syncCrypto';

const GITHUB_ID = '12345678';
const PLAINTEXT = 'test-api-key-12345';

test('encrypt produces scrypt payload by default', () => {
    const encrypted = encrypt(GITHUB_ID, PLAINTEXT, undefined);
    assert.ok(encrypted);
    const payload = JSON.parse(encrypted!);
    assert.strictEqual(payload.algorithm, 'aes-256-gcm');
    assert.strictEqual(payload.kdf, 'scrypt');
    assert.deepStrictEqual(payload.kdfParams, { N: 16384, r: 8, p: 1 });
});

test('scrypt roundtrip without passphrase', () => {
    const encrypted = encrypt(GITHUB_ID, PLAINTEXT, undefined);
    assert.ok(encrypted);
    const decrypted = decrypt(GITHUB_ID, encrypted!, undefined);
    assert.strictEqual(decrypted, PLAINTEXT);
});

test('scrypt roundtrip with passphrase', () => {
    const encrypted = encrypt(GITHUB_ID, PLAINTEXT, 'my-secret-passphrase');
    assert.ok(encrypted);
    const decrypted = decrypt(GITHUB_ID, encrypted!, 'my-secret-passphrase');
    assert.strictEqual(decrypted, PLAINTEXT);
});

test('decrypt fails with wrong passphrase', () => {
    const encrypted = encrypt(GITHUB_ID, PLAINTEXT, 'correct-passphrase');
    assert.ok(encrypted);
    const decrypted = decrypt(GITHUB_ID, encrypted!, 'wrong-passphrase');
    assert.strictEqual(decrypted, undefined);
});

test('decryptWithPassphrase works with correct passphrase', () => {
    const encrypted = encrypt(GITHUB_ID, PLAINTEXT, 'correct-passphrase');
    assert.ok(encrypted);
    const decrypted = decryptWithPassphrase(GITHUB_ID, encrypted!, 'correct-passphrase');
    assert.strictEqual(decrypted, PLAINTEXT);
});

test('decryptWithPassphrase fails with wrong passphrase', () => {
    const encrypted = encrypt(GITHUB_ID, PLAINTEXT, 'correct-passphrase');
    assert.ok(encrypted);
    const decrypted = decryptWithPassphrase(GITHUB_ID, encrypted!, 'wrong-passphrase');
    assert.strictEqual(decrypted, undefined);
});

test('deriveKey returns different keys for different passphrases', () => {
    const salt = Buffer.from('a'.repeat(32));
    const keyA = deriveKey(GITHUB_ID, salt, 'pass-a');
    const keyB = deriveKey(GITHUB_ID, salt, 'pass-b');
    assert.ok(keyA);
    assert.ok(keyB);
    assert.notDeepStrictEqual(keyA, keyB);
});

test('deriveKey returns same key for same inputs', () => {
    const salt = Buffer.from('a'.repeat(32));
    const keyA = deriveKey(GITHUB_ID, salt, 'same-passphrase');
    const keyB = deriveKey(GITHUB_ID, salt, 'same-passphrase');
    assert.ok(keyA);
    assert.ok(keyB);
    assert.deepStrictEqual(keyA, keyB);
});

test('decrypt returns undefined for invalid JSON', () => {
    const decrypted = decrypt(GITHUB_ID, 'not-json', undefined);
    assert.strictEqual(decrypted, undefined);
});

test('decrypt returns undefined for unsupported algorithm', () => {
    const encrypted = JSON.stringify({
        algorithm: 'aes-128-cbc',
        kdf: 'scrypt',
        kdfParams: { N: 16384, r: 8, p: 1 },
        salt: '00',
        iv: '00',
        tag: '00',
        data: '00'
    });
    const decrypted = decrypt(GITHUB_ID, encrypted, undefined);
    assert.strictEqual(decrypted, undefined);
});

test('decrypt returns undefined for non-scrypt kdf payload', () => {
    const encrypted = JSON.stringify({
        algorithm: 'aes-256-gcm',
        kdf: 'pbkdf2',
        kdfParams: { iterations: 600000 },
        salt: '00'.repeat(32),
        iv: '00'.repeat(16),
        tag: '00'.repeat(16),
        data: '00'
    });
    const decrypted = decrypt(GITHUB_ID, encrypted, undefined);
    assert.strictEqual(decrypted, undefined);
});

test('isCurrentKdf returns true for current scrypt format', () => {
    const encrypted = encrypt(GITHUB_ID, PLAINTEXT, undefined);
    assert.ok(encrypted);
    assert.strictEqual(isCurrentKdf(encrypted!), true);
});

test('isCurrentKdf returns false for non-scrypt kdf format', () => {
    const encrypted = JSON.stringify({
        algorithm: 'aes-256-gcm',
        kdf: 'pbkdf2',
        kdfParams: { iterations: 600000 },
        salt: '00'.repeat(32),
        iv: '00'.repeat(16),
        tag: '00'.repeat(16),
        data: '00'
    });
    assert.strictEqual(isCurrentKdf(encrypted), false);
});

test('batch encryptor shares one salt and keeps unique IVs per payload', () => {
    const batchEncrypt = createBatchEncryptor(GITHUB_ID, undefined);
    assert.ok(batchEncrypt);
    const payloads = ['key-a', 'key-b', 'key-c'].map(p => JSON.parse(batchEncrypt!(p)));
    const salts = new Set(payloads.map(p => p.salt));
    const ivs = new Set(payloads.map(p => p.iv));
    assert.strictEqual(salts.size, 1);
    assert.strictEqual(ivs.size, 3);
});

test('batch decryptor roundtrips shared-salt payloads from the same batch', () => {
    const batchEncrypt = createBatchEncryptor(GITHUB_ID, 'pass-x');
    assert.ok(batchEncrypt);
    const encrypted = ['key-a', 'key-b'].map(p => batchEncrypt!(p));
    const batchDecrypt = createBatchDecryptor(GITHUB_ID, 'pass-x');
    assert.deepStrictEqual(
        encrypted.map(e => batchDecrypt(e)),
        ['key-a', 'key-b']
    );
});

test('batch decryptor handles payloads with mixed salts', () => {
    const encryptA = createBatchEncryptor(GITHUB_ID, undefined);
    const encryptB = createBatchEncryptor(GITHUB_ID, undefined);
    assert.ok(encryptA);
    assert.ok(encryptB);
    const payloads = [encryptA!('from-a'), encryptB!('from-b'), encryptA!('from-a2')];
    const batchDecrypt = createBatchDecryptor(GITHUB_ID, undefined);
    assert.deepStrictEqual(
        payloads.map(p => batchDecrypt(p)),
        ['from-a', 'from-b', 'from-a2']
    );
});

test('batch decryptor rejects wrong passphrase', () => {
    const batchEncrypt = createBatchEncryptor(GITHUB_ID, 'correct-passphrase');
    assert.ok(batchEncrypt);
    const encrypted = batchEncrypt!(PLAINTEXT);
    const batchDecrypt = createBatchDecryptor(GITHUB_ID, 'wrong-passphrase');
    assert.strictEqual(batchDecrypt(encrypted), undefined);
});

test('batch payloads can rotate to a new passphrase and roll back without losing values', () => {
    const values = ['key-a', 'key-b'];
    const oldEncrypt = createBatchEncryptor(GITHUB_ID, 'old-passphrase');
    assert.ok(oldEncrypt);
    const oldPayloads = values.map(value => oldEncrypt!(value));

    const oldDecrypt = createBatchDecryptor(GITHUB_ID, 'old-passphrase');
    const newEncrypt = createBatchEncryptor(GITHUB_ID, 'new-passphrase');
    assert.ok(newEncrypt);
    const newPayloads = oldPayloads.map(payload => newEncrypt!(oldDecrypt(payload)!));

    const newDecrypt = createBatchDecryptor(GITHUB_ID, 'new-passphrase');
    assert.deepStrictEqual(
        newPayloads.map(payload => newDecrypt(payload)),
        values
    );
    assert.deepStrictEqual(
        newPayloads.map(payload => oldDecrypt(payload)),
        [undefined, undefined]
    );

    const rollbackEncrypt = createBatchEncryptor(GITHUB_ID, 'old-passphrase');
    assert.ok(rollbackEncrypt);
    const rolledBackPayloads = newPayloads.map(payload => rollbackEncrypt!(newDecrypt(payload)!));
    assert.deepStrictEqual(
        rolledBackPayloads.map(payload => oldDecrypt(payload)),
        values
    );
});
