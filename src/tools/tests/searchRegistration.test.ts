import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

interface ToolContribution {
    name: string;
    when?: string;
    toolReferenceName?: string;
}

interface ToolManifest {
    contributes: { languageModelTools: ToolContribution[] };
    dependencies: Record<string, string>;
}

const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as ToolManifest;
const searchTools = ['gcmp_zhipuWebSearch', 'gcmp_minimaxWebSearch', 'gcmp_kimiWebSearch', 'gcmp_stepfunWebSearch'];
const visionTools = [
    'gcmp_visionTool_uiToArtifact',
    'gcmp_visionTool_extractTextFromScreenshot',
    'gcmp_visionTool_diagnoseErrorScreenshot',
    'gcmp_visionTool_understandTechnicalDiagram',
    'gcmp_visionTool_analyzeDataVisualization',
    'gcmp_visionTool_uiDiffCheck',
    'gcmp_visionTool_analyzeImage'
];

function readSource(path: string): string {
    return readFileSync(new URL(path, root), 'utf8');
}

test('tool manifest retains the remaining search and vision tools without DashScope MCP', () => {
    const names = manifest.contributes.languageModelTools.map(tool => tool.name);
    assert.deepEqual(names.sort(), [...searchTools, ...visionTools].sort());
    assert.equal(new Set(names).size, names.length);
    assert.equal(
        manifest.contributes.languageModelTools.some(tool => tool.toolReferenceName === 'bailianWebSearch'),
        false
    );
});

test('search registry and exports no longer reference the DashScope tool', () => {
    const registry = readSource('src/tools/registry.ts');
    const registeredSearchTools = [...registry.matchAll(/vscode\.lm\.registerTool\('(gcmp_[^']+)'/g)].map(
        match => match[1]
    );
    assert.deepEqual(registeredSearchTools.sort(), [...searchTools].sort());
    assert.doesNotMatch(registry, /[Dd]ashscope/);
    for (const name of visionTools) {
        assert.ok(registry.includes(name), name);
    }
    assert.doesNotMatch(readSource('src/tools/index.ts'), /[Dd]ashscope/);
});

test('tool availability declarations only track the remaining search providers', () => {
    const context = readSource('src/tools/toolContextManager.ts');
    const declaredKeys = [...context.matchAll(/'(gcmp\.tool\.[^']+\.enabled)'/g)].map(match => match[1]);
    const expectedKeys = searchTools.map(name => `gcmp.tool.${name.slice('gcmp_'.length)}.enabled`);
    assert.deepEqual(declaredKeys.sort(), expectedKeys.sort());
    assert.doesNotMatch(context, /\bdashscope\b/);
    assert.match(context, /'minimax-token': 'minimax'/);
});

test('tool translations remove DashScope entries and resolve every remaining manifest label', () => {
    const labelKeys = [...JSON.stringify(manifest.contributes.languageModelTools).matchAll(/%([^%]+)%/g)].map(
        match => match[1]!
    );
    for (const filename of ['package.nls.json', 'package.nls.zh-cn.json']) {
        const labels = JSON.parse(readSource(filename)) as Record<string, string>;
        assert.equal(
            Object.keys(labels).some(key => key.startsWith('tool.dashscopeWebSearch.')),
            false,
            filename
        );
        for (const key of labelKeys) {
            assert.equal(typeof labels[key], 'string', `${filename}: ${key}`);
        }
    }
});

test('readmes no longer advertise bailianWebSearch and retain other search instructions', () => {
    for (const filename of ['README.md', 'README.en.md']) {
        const text = readSource(filename);
        assert.doesNotMatch(text, /bailianWebSearch/, filename);
        for (const name of searchTools) {
            assert.ok(text.includes(`#${name.slice('gcmp_'.length)}`), `${filename}: ${name}`);
        }
    }
});

test('shared MCP dependency and the remaining MCP clients are retained', () => {
    assert.equal(typeof manifest.dependencies['@modelcontextprotocol/sdk'], 'string');
    for (const filename of ['stepfunMCPClient.ts', 'zhipuMCPClient.ts']) {
        const source = readSource(`src/tools/mcp/${filename}`);
        assert.match(source, /@modelcontextprotocol\/sdk\//);
        assert.match(source, /mcpCacheHelpers/);
    }
});
