import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parse } from 'jsonc-parser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const child = path.join(root, 'extensions/gcmp-fim-nes');
const nodeRequire = createRequire(path.join(root, 'package.json'));
const assets = [
    'cl100k_base.tiktoken',
    'o200k_base.tiktoken',
    'tree-sitter.wasm',
    ...['c-sharp', 'cpp', 'go', 'javascript', 'python', 'ruby', 'typescript', 'tsx', 'java', 'rust', 'php'].map(
        name => `tree-sitter-${name}.wasm`
    )
];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

interface BuildConfig {
    outfile: string;
}
interface Workflow {
    jobs: Record<
        string,
        {
            steps: Array<{
                name: string;
                id?: string;
                if?: string;
                env?: Record<string, string>;
                run?: string;
                uses?: string;
                with?: { path?: string; files?: string };
            }>;
        }
    >;
}
function fixture(directory: string, options: { watch?: boolean; missing?: string; copyFailure?: boolean } = {}) {
    const logs: string[] = [];
    const exits: number[] = [];
    const copied: string[] = [];
    const pending: Array<{ config: BuildConfig; resolve(): void; reject(error: Error): void; watches: number }> = [];
    const build = async (config: BuildConfig) => {
        logs.push(`BUILT ${config.outfile}`);
        return {};
    };
    const esbuild = {
        build,
        context: async (config: BuildConfig) => {
            let resolve!: () => void;
            let reject!: (error: Error) => void;
            const done = new Promise<void>((ok, failed) => {
                resolve = ok;
                reject = failed;
            });
            // 未修复脚本不订阅初编结果，避免刻意失败时制造未处理拒绝。
            void done.catch(() => {});
            const entry = { config, resolve, reject, watches: 0 };
            pending.push(entry);
            return {
                watch: async () => {
                    entry.watches++;
                    logs.push('[watch] build finished, watching for changes...');
                },
                rebuild: () => done
            };
        }
    };
    const exists = (filename: string) => path.basename(filename) !== options.missing && fs.existsSync(filename);
    const mockFs = {
        ...fs,
        existsSync: exists,
        promises: {
            access: async (filename: string) => {
                if (!exists(filename)) {
                    throw new Error('Missing asset');
                }
            },
            mkdir: async () => {},
            rm: async () => {},
            copyFile: async (source: string, destination: string) => {
                if (!exists(source) || options.copyFailure) {
                    throw new Error('Required asset copy failed');
                }
                copied.push(path.basename(destination));
            }
        }
    };
    const importer = Object.assign(
        (id: string) =>
            id === 'esbuild' ? esbuild
            : id === 'fs' ? mockFs
            : nodeRequire(id),
        {
            resolve: nodeRequire.resolve
        }
    );
    const source = fs.readFileSync(path.join(directory, 'esbuild.config.js'), 'utf8');
    assert.match(source, /build\(\);\s*$/);
    const execute = new Function(
        'require',
        '__dirname',
        'process',
        'console',
        source.replace(/build\(\);\s*$/, 'return build();')
    ) as (require: typeof importer, directory: string, process: object, console: object) => Promise<void>;
    const done = execute(
        importer,
        directory,
        {
            argv: ['node', 'esbuild.config.js', '--dev', ...(options.watch ? ['--watch'] : [])],
            exit: (code: number) => exits.push(code)
        },
        {
            log: (...args: unknown[]) => logs.push(args.join(' ')),
            warn: (...args: unknown[]) => logs.push(args.join(' ')),
            error: (...args: unknown[]) => logs.push(args.join(' '))
        }
    );
    return { done, logs, exits, copied, pending };
}

for (const [name, directory, expectedAssets, bundles] of [
    ['main', root, ['o200k_base.tiktoken'], 6],
    ['FIM/NES', child, assets, 3]
] as const) {
    test(`${name} watch waits for every initial bundle and copies required assets`, async () => {
        const f = fixture(directory, { watch: true });
        await tick();
        assert.equal(f.pending.length, bundles);
        assert.equal(f.logs.includes('GCMP_WATCH_READY'), false);
        for (const entry of f.pending.slice(0, -1)) {
            entry.resolve();
        }
        await tick();
        assert.equal(f.logs.includes('GCMP_WATCH_READY'), false);
        f.pending.at(-1)!.resolve();
        await f.done;
        assert.deepEqual(f.exits, []);
        assert.deepEqual([...f.copied].sort(), [...expectedAssets].sort());
        assert.equal(f.logs.filter(line => line === 'GCMP_WATCH_READY').length, 1);
        assert.equal(f.logs.includes('GCMP_WATCH_START'), true);
        assert.equal(
            f.pending.every(entry => entry.watches === 1),
            true
        );
    });
    test(`${name} initial bundle failure never emits aggregate readiness`, async () => {
        const f = fixture(directory, { watch: true });
        await tick();
        for (const entry of f.pending.slice(0, -1)) {
            entry.resolve();
        }
        f.pending.at(-1)!.reject(new Error('Synthetic compilation failure'));
        await f.done;
        assert.deepEqual(f.exits, [1]);
        assert.equal(f.logs.includes('GCMP_WATCH_READY'), false);
    });
    for (const watch of [false, true]) {
        test(`${name} missing tokenizer fails build (watch=${watch})`, async () => {
            const f = fixture(directory, { watch, missing: 'o200k_base.tiktoken' });
            await tick();
            for (const entry of f.pending) {
                entry.resolve();
            }
            await f.done;
            assert.deepEqual(f.exits, [1]);
            assert.equal(f.logs.includes('GCMP_WATCH_READY'), false);
        });
        test(`${name} asset copy failure fails build (watch=${watch})`, async () => {
            const f = fixture(directory, { watch, copyFailure: true });
            await tick();
            for (const entry of f.pending) {
                entry.resolve();
            }
            await f.done;
            assert.deepEqual(f.exits, [1]);
            assert.equal(f.logs.includes('GCMP_WATCH_READY'), false);
        });
    }
}

test('FIM/NES missing grammar fails build instead of creating an incomplete package', async () => {
    const f = fixture(child, { missing: 'tree-sitter-tsx.wasm' });
    await f.done;
    assert.deepEqual(f.exits, [1]);
});

test('child includes the same MIT license as the main extension', () => {
    const childLicense = fs.readFileSync(path.join(child, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
    const mainLicense = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
    assert.equal(childLicense, mainLicense);
});

test('CI and release both validate and package the independent child extension', () => {
    const yaml = nodeRequire('js-yaml') as { load(source: string): unknown };
    for (const filename of ['ci.yml', 'release.yml']) {
        const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows', filename), 'utf8')) as Workflow;
        const steps = Object.values(workflow.jobs)[0].steps;
        const runs = steps.map(step => step.run);
        for (const command of [
            'npm run lint',
            'npm run typecheck',
            'npm test',
            'npm run test:fim-nes',
            'npm run package',
            'npm run package:fim-nes'
        ]) {
            assert.ok(runs.includes(command), `${filename}: ${command}`);
        }
        const uploads = steps.filter(step =>
            step.uses?.includes(filename === 'ci.yml' ? 'upload-artifact' : 'action-gh-release')
        );
        assert.ok(
            uploads.some(upload => (upload.with?.path ?? upload.with?.files)?.includes('extensions/gcmp-fim-nes/'))
        );
        if (filename === 'release.yml') {
            const publish = steps.findIndex(step => step.name === 'Publish to VS Code Marketplace');
            assert.ok(steps.findIndex(step => step.name === 'Get package info') < publish);
            assert.ok(steps.findIndex(step => step.name === 'Extract changelog for release') < publish);
            assert.match(steps[publish].run!, /for PACKAGE_PATH in "\$\{PACKAGES\[@\]\}"/);
            assert.match(steps[publish].run!, /--packagePath/);
            assert.match(steps[publish].run!, /--allow-proposed-apis chatProvider/);
            assert.match(steps[publish].run!, /MAX_ATTEMPTS=3/);
            assert.match(steps[publish].run!, /\$EXTENSION_ID v\$PACKAGE_VERSION already exists/);
        }
    }
});

test('FIM/NES release packages, publishes and uploads only when the tag matches its own version', () => {
    const yaml = nodeRequire('js-yaml') as { load(source: string): unknown };
    const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')) as Workflow;
    const steps = workflow.jobs.deploy.steps;
    const info = steps.find(step => step.id === 'package');
    assert.ok(info);
    assert.equal(info.env?.RELEASE_TAG, '${{ github.event.release.tag_name }}');
    const expression = info.run?.match(/^PUBLISH_FIM=\$\(node -p "([^"]+)"\)$/m)?.[1];
    assert.ok(expression);
    for (const [tag, expected] of [
        ['v1.2.3', true],
        ['1.2.3', true],
        ['v1.2.4', false],
        ['v1.2.3-p1', false],
        ['release-1.2.3', false],
        ['vv1.2.3', false],
        ['', false],
        ["v1.2.3'; throw new Error('unexpected execution');", false]
    ] as const) {
        const result: unknown = runInNewContext(expression, {
            process: { env: { RELEASE_TAG: tag } },
            require: (manifest: string) => {
                assert.equal(manifest, './extensions/gcmp-fim-nes/package.json');
                return { version: '1.2.3' };
            }
        });
        assert.equal(result, expected, tag);
    }
    assert.match(info.run!, /echo "publish_fim=\$PUBLISH_FIM" >> \$GITHUB_OUTPUT/);
    assert.match(info.run!, /if \[ "\$PUBLISH_FIM" = "true" \]; then\s+VERSIONS\+=\("\$FIM_VERSION"\)/);
    const packageStep = steps.find(step => step.run === 'npm run package:fim-nes');
    const upload = steps.find(step => step.with?.files?.includes('extensions/gcmp-fim-nes/'));
    for (const step of [packageStep, upload]) {
        assert.ok(step);
        assert.equal(step.if, "steps.package.outputs.publish_fim == 'true'");
        assert.ok(steps.indexOf(step) > steps.indexOf(info));
    }
    const publish = steps.find(step => step.id === 'publish');
    assert.equal(publish?.env?.PUBLISH_FIM, '${{ steps.package.outputs.publish_fim }}');
    assert.match(publish?.run ?? '', /PACKAGES=\("\$MAIN_PACKAGE"\)/);
    assert.match(
        publish?.run ?? '',
        /if \[ "\$PUBLISH_FIM" = "true" \]; then\s+PACKAGES=\("\$FIM_PACKAGE" "\$\{PACKAGES\[@\]\}"\)/
    );
    const mainUpload = steps.find(step => step.with?.files === '${{ steps.package.outputs.filename }}');
    assert.ok(mainUpload);
    assert.equal(mainUpload.if, undefined);
});

for (const name of [
    'Run Extension',
    'Run Extension (Watch Mode)',
    'Run FIM/NES Extension',
    'Run FIM/NES Extension (Watch Mode)',
    'Run Both Extensions',
    'Run Both Extensions (Watch Mode)',
    'Extension Tests'
]) {
    test(`${name} explicitly enables the main chatProvider proposal`, () => {
        const launch = parse(fs.readFileSync(path.join(root, '.vscode/launch.json'), 'utf8')) as {
            configurations: Array<{ name: string; args: string[] }>;
        };
        const config = launch.configurations.find(config => config.name === name);
        assert.ok(config);
        assert.deepEqual(
            config.args.filter(arg => arg.startsWith('--enable-proposed-api=')),
            ['--enable-proposed-api=vicanent.gcmp']
        );
    });
}

test('debug watchers match only aggregate readiness, not esbuild individual bundle logs', () => {
    const tasks = parse(fs.readFileSync(path.join(root, '.vscode/tasks.json'), 'utf8')) as {
        tasks: Array<{
            isBackground?: boolean;
            script?: string;
            problemMatcher?: {
                background?: { beginsPattern: string; endsPattern: string };
            };
        }>;
    };
    const watchers = tasks.tasks.filter(task => task.script?.startsWith('watch'));
    assert.equal(watchers.length, 3);
    for (const task of watchers) {
        const background = task.problemMatcher?.background;
        assert.ok(background);
        assert.equal(new RegExp(background.endsPattern).test('[watch] build finished, watching for changes...'), false);
        assert.equal(new RegExp(background.endsPattern).test('GCMP_WATCH_READY'), true);
        assert.equal(new RegExp(background.beginsPattern).test('GCMP_WATCH_START'), true);
    }
});
