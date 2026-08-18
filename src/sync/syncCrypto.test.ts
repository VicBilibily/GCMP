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

test('encrypt produces scrypt payload by default', async () => {
    const encrypted = await encrypt(GITHUB_ID, PLAINTEXT, undefined);
    assert.ok(encrypted);
    const payload = JSON.parse(encrypted!);
    assert.strictEqual(payload.algorithm, 'aes-256-gcm');
    assert.strictEqual(payload.kdf, 'scrypt');
    assert.deepStrictEqual(payload.kdfParams, { N: 16384, r: 8, p: 1 });
});

test('scrypt roundtrip without passphrase', async () => {
    const encrypted = await encrypt(GITHUB_ID, PLAINTEXT, undefined);
    assert.ok(encrypted);
    const decrypted = await decrypt(GITHUB_ID, encrypted!, undefined);
    assert.strictEqual(decrypted, PLAINTEXT);
});

test('scrypt roundtrip with passphrase', async () => {
    const encrypted = await encrypt(GITHUB_ID, PLAINTEXT, 'my-secret-passphrase');
    assert.ok(encrypted);
    const decrypted = await decrypt(GITHUB_ID, encrypted!, 'my-secret-passphrase');
    assert.strictEqual(decrypted, PLAINTEXT);
});

test('decrypt fails with wrong passphrase', async () => {
    const encrypted = await encrypt(GITHUB_ID, PLAINTEXT, 'correct-passphrase');
    assert.ok(encrypted);
    const decrypted = await decrypt(GITHUB_ID, encrypted!, 'wrong-passphrase');
    assert.strictEqual(decrypted, undefined);
});

test('decryptWithPassphrase works with correct passphrase', async () => {
    const encrypted = await encrypt(GITHUB_ID, PLAINTEXT, 'correct-passphrase');
    assert.ok(encrypted);
    const decrypted = await decryptWithPassphrase(GITHUB_ID, encrypted!, 'correct-passphrase');
    assert.strictEqual(decrypted, PLAINTEXT);
});

test('decryptWithPassphrase fails with wrong passphrase', async () => {
    const encrypted = await encrypt(GITHUB_ID, PLAINTEXT, 'correct-passphrase');
    assert.ok(encrypted);
    const decrypted = await decryptWithPassphrase(GITHUB_ID, encrypted!, 'wrong-passphrase');
    assert.strictEqual(decrypted, undefined);
});

test('deriveKey returns different keys for different passphrases', async () => {
    const salt = Buffer.from('a'.repeat(32));
    const keyA = await deriveKey(GITHUB_ID, salt, 'pass-a');
    const keyB = await deriveKey(GITHUB_ID, salt, 'pass-b');
    assert.ok(keyA);
    assert.ok(keyB);
    assert.notDeepStrictEqual(keyA, keyB);
});

test('deriveKey returns same key for same inputs', async () => {
    const salt = Buffer.from('a'.repeat(32));
    const keyA = await deriveKey(GITHUB_ID, salt, 'same-passphrase');
    const keyB = await deriveKey(GITHUB_ID, salt, 'same-passphrase');
    assert.ok(keyA);
    assert.ok(keyB);
    assert.deepStrictEqual(keyA, keyB);
});

test('decrypt returns undefined for invalid JSON', async () => {
    const decrypted = await decrypt(GITHUB_ID, 'not-json', undefined);
    assert.strictEqual(decrypted, undefined);
});

test('decrypt returns undefined for unsupported algorithm', async () => {
    const encrypted = JSON.stringify({
        algorithm: 'aes-128-cbc',
        kdf: 'scrypt',
        kdfParams: { N: 16384, r: 8, p: 1 },
        salt: '00',
        iv: '00',
        tag: '00',
        data: '00'
    });
    const decrypted = await decrypt(GITHUB_ID, encrypted, undefined);
    assert.strictEqual(decrypted, undefined);
});

test('decrypt returns undefined for non-scrypt kdf payload', async () => {
    const encrypted = JSON.stringify({
        algorithm: 'aes-256-gcm',
        kdf: 'pbkdf2',
        kdfParams: { iterations: 600000 },
        salt: '00'.repeat(32),
        iv: '00'.repeat(16),
        tag: '00'.repeat(16),
        data: '00'
    });
    const decrypted = await decrypt(GITHUB_ID, encrypted, undefined);
    assert.strictEqual(decrypted, undefined);
});

test('decrypt returns undefined for malformed hex payload', async () => {
    const encrypted = JSON.stringify({
        algorithm: 'aes-256-gcm',
        kdf: 'scrypt',
        kdfParams: { N: 16384, r: 8, p: 1 },
        salt: 'zz',
        iv: '00'.repeat(16),
        tag: '00'.repeat(16),
        data: '00'
    });
    const batchDecrypt = createBatchDecryptor(GITHUB_ID, undefined);

    assert.strictEqual(await decrypt(GITHUB_ID, encrypted, undefined), undefined);
    assert.strictEqual(await batchDecrypt(encrypted), undefined);

    batchDecrypt.dispose();
});

test('isCurrentKdf returns true for current scrypt format', async () => {
    const encrypted = await encrypt(GITHUB_ID, PLAINTEXT, undefined);
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

test('batch encryptor shares one salt and keeps unique IVs per payload', async () => {
    const batchEncrypt = await createBatchEncryptor(GITHUB_ID, undefined);
    assert.ok(batchEncrypt);
    const payloads = ['key-a', 'key-b', 'key-c'].map(p => JSON.parse(batchEncrypt!(p)));
    const salts = new Set(payloads.map(p => p.salt));
    const ivs = new Set(payloads.map(p => p.iv));
    assert.strictEqual(salts.size, 1);
    assert.strictEqual(ivs.size, 3);
    batchEncrypt!.dispose();
});

test('batch decryptor roundtrips shared-salt payloads from the same batch', async () => {
    const batchEncrypt = await createBatchEncryptor(GITHUB_ID, 'pass-x');
    assert.ok(batchEncrypt);
    const encrypted = ['key-a', 'key-b'].map(p => batchEncrypt!(p));
    const batchDecrypt = createBatchDecryptor(GITHUB_ID, 'pass-x');
    assert.deepStrictEqual(await Promise.all(encrypted.map(e => batchDecrypt(e))), ['key-a', 'key-b']);
    batchEncrypt!.dispose();
    batchDecrypt.dispose();
});

test('batch decryptor handles payloads with mixed salts', async () => {
    const encryptA = await createBatchEncryptor(GITHUB_ID, undefined);
    const encryptB = await createBatchEncryptor(GITHUB_ID, undefined);
    assert.ok(encryptA);
    assert.ok(encryptB);
    const payloads = [encryptA!('from-a'), encryptB!('from-b'), encryptA!('from-a2')];
    const batchDecrypt = createBatchDecryptor(GITHUB_ID, undefined);
    assert.deepStrictEqual(await Promise.all(payloads.map(p => batchDecrypt(p))), ['from-a', 'from-b', 'from-a2']);
    encryptA!.dispose();
    encryptB!.dispose();
    batchDecrypt.dispose();
});

test('batch decryptor rejects wrong passphrase', async () => {
    const batchEncrypt = await createBatchEncryptor(GITHUB_ID, 'correct-passphrase');
    assert.ok(batchEncrypt);
    const encrypted = batchEncrypt!(PLAINTEXT);
    const batchDecrypt = createBatchDecryptor(GITHUB_ID, 'wrong-passphrase');
    assert.strictEqual(await batchDecrypt(encrypted), undefined);
    batchEncrypt!.dispose();
    batchDecrypt.dispose();
});

test('batch encryptor throws after dispose', async () => {
    const batchEncrypt = await createBatchEncryptor(GITHUB_ID, undefined);
    assert.ok(batchEncrypt);
    batchEncrypt!.dispose();
    assert.throws(() => batchEncrypt!(PLAINTEXT));
});

test('batch payloads can rotate to a new passphrase and roll back without losing values', async () => {
    const values = ['key-a', 'key-b'];
    const oldEncrypt = await createBatchEncryptor(GITHUB_ID, 'old-passphrase');
    assert.ok(oldEncrypt);
    const oldPayloads = values.map(value => oldEncrypt!(value));

    const oldDecrypt = createBatchDecryptor(GITHUB_ID, 'old-passphrase');
    const newEncrypt = await createBatchEncryptor(GITHUB_ID, 'new-passphrase');
    assert.ok(newEncrypt);
    const newPayloads: string[] = [];
    for (const payload of oldPayloads) {
        newPayloads.push(newEncrypt!((await oldDecrypt(payload))!));
    }

    const newDecrypt = createBatchDecryptor(GITHUB_ID, 'new-passphrase');
    assert.deepStrictEqual(await Promise.all(newPayloads.map(payload => newDecrypt(payload))), values);
    assert.deepStrictEqual(await Promise.all(newPayloads.map(payload => oldDecrypt(payload))), [undefined, undefined]);

    const rollbackEncrypt = await createBatchEncryptor(GITHUB_ID, 'old-passphrase');
    assert.ok(rollbackEncrypt);
    const rolledBackPayloads: string[] = [];
    for (const payload of newPayloads) {
        rolledBackPayloads.push(rollbackEncrypt!((await newDecrypt(payload))!));
    }
    assert.deepStrictEqual(await Promise.all(rolledBackPayloads.map(payload => oldDecrypt(payload))), values);

    oldEncrypt!.dispose();
    oldDecrypt.dispose();
    newEncrypt!.dispose();
    newDecrypt.dispose();
    rollbackEncrypt!.dispose();
});
