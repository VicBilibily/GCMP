import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../src/interInstance';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { TokenFileLogger } from '../../../src/usages/fileLogger';
import { DateUtils } from '../../../src/usages/fileLogger/dateUtils';
import { StatsPublication } from '../../../src/usages/fileLogger/refresh/statsPublication';
import { StatsCalculator } from '../../../src/usages/fileLogger/statsCalculator';
import { TokenUsagesManager } from '../../../src/usages/usagesManager';

interface ElectionState {
    context: vscode.ExtensionContext | undefined;
    instanceId: string;
    initialized: boolean;
    stopping: boolean;
    agentsWindow: boolean;
    _isLeader: boolean;
    ownElectedAt: number;
    lastCandidateElectedAt: number;
    candidateAuthority: unknown;
    ownedCandidateAuthority: unknown;
    electionPausedUntil: number;
    lastLeaderIdentityKey: string | undefined;
    lifecycleGeneration: number;
    decisionGeneration: number;
}
interface ElectionInternals extends ElectionState {
    checkLeader(): Promise<void>;
}
function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => {
        release = resolve;
    });
    return { promise, release };
}

suite('Statistics publication follows the current shared leader identity', () => {
    const election = LeaderElectionService as unknown as ElectionInternals;
    const originalPublish = InterInstanceBus.publish;
    const originalRead = StatsPublication.prototype.readPendingStats;
    let previous: ElectionState;
    let dir: string, fileLogger: TokenFileLogger, manager: TokenUsagesManager;
    let state: Map<string, unknown>, context: vscode.ExtensionContext;
    let broadcasts: number;

    setup(async () => {
        previous = {
            context: election.context,
            instanceId: election.instanceId,
            initialized: election.initialized,
            stopping: election.stopping,
            agentsWindow: election.agentsWindow,
            _isLeader: election._isLeader,
            ownElectedAt: election.ownElectedAt,
            lastCandidateElectedAt: election.lastCandidateElectedAt,
            candidateAuthority: election.candidateAuthority,
            ownedCandidateAuthority: election.ownedCandidateAuthority,
            electionPausedUntil: election.electionPausedUntil,
            lastLeaderIdentityKey: election.lastLeaderIdentityKey,
            lifecycleGeneration: election.lifecycleGeneration,
            decisionGeneration: election.decisionGeneration
        };
        broadcasts = 0;
        InterInstanceBus.publish = event => {
            if (event.type === 'tokenUsageUpdated') {
                broadcasts++;
            }
        };
        dir = await mkdtemp(join(tmpdir(), 'gcmp-publication-authority-'));
        state = new Map();
        context = {
            globalStorageUri: vscode.Uri.file(dir),
            subscriptions: [],
            globalState: {
                get<T>(key: string): T | undefined {
                    return state.get(key) as T | undefined;
                },
                async update(key: string, value: unknown) {
                    state.set(key, value);
                }
            }
        } as unknown as vscode.ExtensionContext;
        state.set('gcmp.leader.info.v2', {
            instanceId: 'publication-leader',
            electedAt: 100000,
            lastHeartbeat: Date.now()
        });
        Object.assign(election, {
            context,
            instanceId: 'publication-leader',
            initialized: true,
            stopping: false,
            agentsWindow: false,
            _isLeader: false,
            ownElectedAt: 0,
            lastCandidateElectedAt: 0,
            candidateAuthority: undefined,
            ownedCandidateAuthority: undefined,
            electionPausedUntil: 0,
            lastLeaderIdentityKey: undefined
        });
        await election.checkLeader();
        assert.equal(LeaderElectionService.isLeader(), true);
        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'publication-leader:100000');
        fileLogger = new TokenFileLogger(context);
        manager = new (TokenUsagesManager as unknown as new () => TokenUsagesManager)();
        Object.assign(manager, { initialized: true, fileLogger });
    });

    teardown(async () => {
        StatsPublication.prototype.readPendingStats = originalRead;
        await manager?.dispose();
        for (const subscription of context?.subscriptions ?? []) {
            subscription.dispose();
        }
        Object.assign(election, previous);
        InterInstanceBus.publish = originalPublish;
        await rm(dir, { recursive: true, force: true });
    });

    for (const scenario of [
        'owner',
        'follower',
        'identity-before',
        'identity-during',
        'role-during',
        'owner-term',
        'missing-before',
        'missing-during'
    ] as const) {
        test(`${scenario}: historical publication revalidates identity`, async () => {
            const date = DateUtils.getDateStringDaysAgo(1),
                stats = StatsCalculator.aggregateLogs([]);
            stats.total.requests = 3;
            const folder = join(dir, 'usages', date),
                statsPath = join(fileLogger.getStorageDir(), date, 'stats.json');
            const publication = (fileLogger as unknown as { logStatsManager: { publication: StatsPublication } })
                .logStatsManager.publication;
            const fingerprint = createHash('sha256').update(JSON.stringify(stats)).digest('hex');
            await mkdir(folder, { recursive: true });
            await writeFile(statsPath, JSON.stringify(stats));
            const replace = () => {
                if (scenario.startsWith('missing')) {
                    state.delete('gcmp.leader.info.v2');
                } else {
                    state.set('gcmp.leader.info.v2', {
                        instanceId: 'publication-successor',
                        electedAt: 200000,
                        lastHeartbeat: Date.now()
                    });
                }
            };
            if (scenario.endsWith('before') || scenario === 'follower') {
                replace();
                if (scenario === 'follower') {
                    await election.checkLeader();
                }
            }
            if (scenario === 'owner-term') {
                state.set('gcmp.leader.info.v2', {
                    instanceId: 'publication-leader',
                    electedAt: 200000,
                    lastHeartbeat: Date.now()
                });
                await election.checkLeader();
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'publication-leader:200000');
            }
            if (scenario.endsWith('during')) {
                const entered = gate(),
                    release = gate();
                StatsPublication.prototype.readPendingStats = async function (path: string) {
                    const result = await originalRead.call(this, path);
                    entered.release();
                    await release.promise;
                    return result;
                };
                const work = fileLogger.recoverStatsPublications(result => manager.notifyStatsUpdate(result));
                try {
                    await entered.promise;
                    replace();
                    if (scenario === 'role-during') {
                        await election.checkLeader();
                    }
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
                } finally {
                    release.release();
                }
                await work;
                StatsPublication.prototype.readPendingStats = originalRead;
            }
            for (let round = 0; round < 3; round++) {
                await fileLogger.recoverStatsPublications(result => manager.notifyStatsUpdate(result));
                await fileLogger.flush();
            }
            const expected = scenario === 'owner' || scenario === 'owner-term' ? 1 : 0;
            assert.equal(broadcasts, expected);
            assert.equal(await publication.isPending(statsPath, fingerprint), expected === 0);
        });
    }
});
