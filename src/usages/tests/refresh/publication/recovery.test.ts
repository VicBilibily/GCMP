import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { test } from 'node:test';
import { AtomicJsonFile } from '../../../atomicJsonFile';
import { fingerprint, publicationFixture, publicationStats } from '../../../fileLogger/refresh/publicationCacheFixture';
import { StatsPublication } from '../../../fileLogger/refresh/statsPublication';

test('publication recovery follows the committed version after competing preparations', async context => {
    for (const successor of [false, true]) {
        await context.test(`committed fingerprint displaced; successor preparation=${successor}`, async child => {
            const f = await publicationFixture(child, true);
            const winner = publicationStats(3);
            const winnerFingerprint = fingerprint(winner);
            await new StatsPublication().prepare(f.statsPath, winnerFingerprint);
            await new StatsPublication().prepare(f.statsPath, fingerprint(publicationStats(4)));
            await AtomicJsonFile.writeJsonAtomically(f.statsPath, winner);
            if (successor) {
                await new StatsPublication().prepare(f.statsPath, fingerprint(publicationStats(5)));
            }
            const publication = new StatsPublication();
            const markerBefore = await fs.readFile(f.markerPath, 'utf8');
            const receiptBefore = await fs.readFile(f.receiptPath, 'utf8');
            const marker = JSON.parse(markerBefore) as { pending: string[] };
            assert.ok(marker.pending.length <= 2);
            assert.equal(await publication.isPending(f.statsPath, 'not-current'), false);
            assert.equal(await publication.acknowledge(f.statsPath, 'not-current', () => true), false);
            assert.equal(await publication.isPending(f.statsPath, winnerFingerprint), true);
            assert.deepEqual(await publication.readPendingStats(f.statsPath), winner);
            assert.equal(await fs.readFile(f.markerPath, 'utf8'), markerBefore);
            assert.equal(await fs.readFile(f.receiptPath, 'utf8'), receiptBefore);
            assert.equal(await publication.acknowledge(f.statsPath, winnerFingerprint, () => true), true);
            assert.equal(await publication.isPending(f.statsPath, winnerFingerprint), false);
            assert.equal(await new StatsPublication().readPendingStats(f.statsPath), undefined);
            assert.equal(await fs.readFile(f.markerPath, 'utf8'), markerBefore);
        });
    }
    await context.test('preparations without a commit do not republish the acknowledged base', async child => {
        const f = await publicationFixture(child, true);
        const saved = await fs.readFile(f.statsPath, 'utf8');
        const receipt = await fs.readFile(f.receiptPath, 'utf8');
        for (const requests of [3, 4, 5]) {
            await new StatsPublication().prepare(f.statsPath, fingerprint(publicationStats(requests)));
        }
        const publication = new StatsPublication();
        assert.equal(await publication.readPendingStats(f.statsPath), undefined);
        assert.equal(await publication.isPending(f.statsPath, fingerprint(f.current)), false);
        assert.equal(await publication.acknowledge(f.statsPath, fingerprint(f.current), () => true), false);
        assert.equal(await fs.readFile(f.statsPath, 'utf8'), saved);
        assert.equal(await fs.readFile(f.receiptPath, 'utf8'), receipt);
    });
    for (const marker of [undefined, { pending: [fingerprint(publicationStats(4))] }]) {
        await context.test(`legacy marker does not infer a publication; marker=${Boolean(marker)}`, async child => {
            const f = await publicationFixture(child, true);
            if (marker) {
                await AtomicJsonFile.writeJsonAtomically(f.markerPath, marker);
            } else {
                await fs.unlink(f.markerPath);
            }
            const current = publicationStats(3);
            await AtomicJsonFile.writeJsonAtomically(f.statsPath, current);
            const publication = new StatsPublication();
            assert.equal(await publication.readPendingStats(f.statsPath), undefined);
            assert.equal(await publication.isPending(f.statsPath, fingerprint(current)), false);
            assert.equal(await publication.acknowledge(f.statsPath, fingerprint(current), () => true), false);
        });
    }
    for (const committed of [false, true]) {
        await context.test(`competing intent matches the acknowledged base; committed=${committed}`, async child => {
            const f = await publicationFixture(child, true);
            const winner = publicationStats(3);
            await new StatsPublication().prepare(f.statsPath, fingerprint(winner));
            await new StatsPublication().prepare(f.statsPath, fingerprint(f.current));
            if (committed) {
                await AtomicJsonFile.writeJsonAtomically(f.statsPath, winner);
            }
            const publication = new StatsPublication();
            assert.deepEqual(await publication.readPendingStats(f.statsPath), committed ? winner : undefined);
            assert.equal(await publication.isPending(f.statsPath, fingerprint(winner)), committed);
            assert.equal(await publication.acknowledge(f.statsPath, fingerprint(winner), () => true), committed);
            assert.equal(await new StatsPublication().readPendingStats(f.statsPath), undefined);
        });
    }
    for (const field of ['baseVersion', 'baseFingerprint']) {
        for (const value of [null, 42, false, {}]) {
            await context.test(`invalid ${field} ${JSON.stringify(value)} is rejected`, async child => {
                const f = await publicationFixture(child, true);
                await AtomicJsonFile.writeJsonAtomically(f.markerPath, { pending: ['new'], [field]: value });
                const publication = new StatsPublication();
                await assert.rejects(
                    publication.readPendingStats(f.statsPath),
                    /Invalid statistics publication marker/
                );
                await assert.rejects(
                    publication.isPending(f.statsPath, 'new'),
                    /Invalid statistics publication marker/
                );
                await assert.rejects(
                    publication.acknowledge(f.statsPath, 'new', () => true),
                    /Invalid statistics publication marker/
                );
            });
        }
    }
});
