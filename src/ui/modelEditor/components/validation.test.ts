import test from 'node:test';
import assert from 'node:assert/strict';
import type { EditorState } from '../app';
import { collectFormData, validateForm, validateLimitConfig } from './validation';

interface MockCheckbox {
    value: string;
    checked: boolean;
}

interface MockElement {
    value?: string;
    checked?: boolean;
    textContent?: string;
    style?: { display: string };
    focus?: () => void;
    scrollIntoView?: () => void;
    closest?: () => { style: { display: string } } | null;
    querySelectorAll?: () => MockCheckbox[];
}

interface MockDocument {
    getElementById(id: string): MockElement | null;
}

Reflect.set(globalThis, 'window', { __VS_CODE_LOCALE__: 'zh-cn' });

function createCheckbox(value: string, checked: boolean) {
    return { value, checked };
}

function createFormGroup(display = 'block') {
    return { style: { display } };
}

function createField(value = ''): MockElement {
    const group = createFormGroup();
    return {
        value,
        focus: () => undefined,
        closest: () => group
    };
}

function installMockDocument(values: Record<string, MockElement | undefined>): void {
    const documentStub: MockDocument = {
        getElementById(id: string) {
            return values[id] ?? null;
        }
    };
    Reflect.set(globalThis, 'document', documentStub);
}

function createEditorState(limit: string, extras?: Partial<EditorState['model']>): EditorState {
    return {
        model: {
            id: 'compatible:test-model',
            name: 'Test Model',
            provider: 'custom-provider',
            tooltip: 'tooltip',
            baseUrl: 'https://api.example.com/v1',
            endpoint: '',
            modelsEndpoint: '',
            proxy: '',
            apiKey: '',
            model: 'upstream-model',
            sdkMode: 'openai',
            maxInputTokens: 128000,
            maxOutputTokens: 4096,
            toolCalling: true,
            imageInput: false,
            serviceTier: [],
            useInstructions: undefined,
            webSearchTool: undefined,
            webSearchToolConfig: '',
            nativeTools: '',
            reasoningEffort: ['medium'],
            reasoningDefault: '',
            limit,
            limitRpm: '',
            limitTpm: '',
            limitParallel: '',
            tokenPricing: '',
            customHeader: '',
            extraBody: '',
            ...extras
        },
        isCreateMode: false,
        providers: [],
        availableModels: [],
        isLoadingModels: false
    };
}

test('validateLimitConfig accepts empty config', () => {
    assert.equal(validateLimitConfig(''), null);
});

test('validateLimitConfig accepts supported positive dimensions', () => {
    assert.equal(validateLimitConfig('{"rpm":60,"rps":2,"tpm":120000,"parallel":3}'), null);
});

test('validateLimitConfig accepts zero as unlimited', () => {
    assert.equal(validateLimitConfig('{"rpm":0,"parallel":0}'), null);
});

test('validateLimitConfig rejects unknown fields', () => {
    assert.equal(validateLimitConfig('{"rpm":60,"timeout":1000}'), '限流配置仅支持 rpm、rps、tpm、parallel。');
});

test('validateLimitConfig rejects negative or invalid numbers', () => {
    assert.equal(validateLimitConfig('{"parallel":-1}'), '限流配置的值必须是大于等于 0 的整数。');
    assert.equal(validateLimitConfig('{"rpm":"60"}'), '限流配置的值必须是大于等于 0 的整数。');
});

test('validateLimitConfig rejects decimal values', () => {
    assert.equal(validateLimitConfig('{"parallel":1.5}'), '限流配置的值必须是大于等于 0 的整数。');
});

test('validateLimitConfig rejects non-object json', () => {
    assert.equal(validateLimitConfig('[1,2,3]'), '限流配置必须是 JSON 对象');
});

test('collectFormData preserves limit when editing other fields', () => {
    installMockDocument({
        modelId: { value: 'compatible:test-model' },
        modelName: { value: 'Test Model Updated' },
        provider: { value: 'custom-provider' },
        modelTooltip: { value: 'tooltip' },
        requestModel: { value: 'upstream-model' },
        baseUrl: { value: 'https://api.example.com/v1' },
        endpoint: { value: '' },
        modelsEndpoint: { value: '' },
        proxy: { value: '' },
        apiKey: { value: '' },
        sdkMode: { value: 'openai' },
        maxInputTokens: { value: '128000' },
        maxOutputTokens: { value: '4096' },
        toolCalling: { checked: true },
        imageInput: { checked: false },
        serviceTierOptions: { querySelectorAll: () => [] },
        useInstructions: { checked: false },
        webSearchTool: { checked: false },
        webSearchToolConfig: { value: '' },
        nativeTools: { value: '' },
        reasoningEffortOptions: { querySelectorAll: () => [createCheckbox('medium', true)] },
        reasoningDefault: { value: '' },
        customHeader: { value: '' },
        extraBody: { value: '' },
        limitRpm: { value: '60' },
        limitParallel: { value: '2' }
    });

    const formData = collectFormData(
        createEditorState('{"rpm":60,"parallel":2}', {
            limitRpm: '60',
            limitParallel: '2',
            tokenPricing: '{"pricing":[0.1,0.2]}'
        })
    );

    assert.ok(formData);
    assert.equal(formData?.name, 'Test Model Updated');
    assert.equal(formData?.limit, '{"rpm":60,"parallel":2}');
    assert.equal(formData?.tokenPricing, '{"pricing":[0.1,0.2]}');
    assert.deepEqual(formData?.reasoningEffort, ['medium']);
});

test('collectFormData preserves hidden limit fields while updating visible limit fields', () => {
    installMockDocument({
        modelId: { value: 'compatible:test-model' },
        modelName: { value: 'Test Model Updated' },
        provider: { value: 'custom-provider' },
        modelTooltip: { value: 'tooltip' },
        requestModel: { value: 'upstream-model' },
        baseUrl: { value: 'https://api.example.com/v1' },
        endpoint: { value: '' },
        modelsEndpoint: { value: '' },
        proxy: { value: '' },
        apiKey: { value: '' },
        sdkMode: { value: 'openai' },
        maxInputTokens: { value: '128000' },
        maxOutputTokens: { value: '4096' },
        toolCalling: { checked: true },
        imageInput: { checked: false },
        serviceTierOptions: { querySelectorAll: () => [] },
        useInstructions: { checked: false },
        webSearchTool: { checked: false },
        webSearchToolConfig: { value: '' },
        nativeTools: { value: '' },
        reasoningEffortOptions: { querySelectorAll: () => [createCheckbox('medium', true)] },
        reasoningDefault: { value: '' },
        customHeader: { value: '' },
        extraBody: { value: '' },
        limitRpm: { value: '60' },
        limitParallel: { value: '2' }
    });

    const formData = collectFormData(
        createEditorState('{"rps":2,"tpm":120000,"parallel":4}', {
            limitTpm: '120000',
            limitParallel: '4'
        })
    );

    assert.equal(formData?.limit, '{"rps":2,"tpm":120000,"parallel":2,"rpm":60}');
    assert.equal(formData?.limitTpm, '120000');
});

test('collectFormData preserves explicit zero as unlimited for visible limit fields', () => {
    installMockDocument({
        modelId: { value: 'compatible:test-model' },
        modelName: { value: 'Test Model Updated' },
        provider: { value: 'custom-provider' },
        modelTooltip: { value: 'tooltip' },
        requestModel: { value: 'upstream-model' },
        baseUrl: { value: 'https://api.example.com/v1' },
        endpoint: { value: '' },
        modelsEndpoint: { value: '' },
        proxy: { value: '' },
        apiKey: { value: '' },
        sdkMode: { value: 'openai' },
        maxInputTokens: { value: '128000' },
        maxOutputTokens: { value: '4096' },
        toolCalling: { checked: true },
        imageInput: { checked: false },
        serviceTierOptions: { querySelectorAll: () => [] },
        useInstructions: { checked: false },
        webSearchTool: { checked: false },
        webSearchToolConfig: { value: '' },
        nativeTools: { value: '' },
        reasoningEffortOptions: { querySelectorAll: () => [createCheckbox('medium', true)] },
        reasoningDefault: { value: '' },
        customHeader: { value: '' },
        extraBody: { value: '' },
        limitRpm: { value: '0' },
        limitParallel: { value: '0' }
    });

    const formData = collectFormData(
        createEditorState('{"rpm":0,"parallel":0}', {
            limitRpm: '0',
            limitParallel: '0'
        })
    );

    assert.equal(formData?.limit, '{"rpm":0,"parallel":0}');
});

test('validateForm rejects decimal visible limit fields', () => {
    const globalErrorBanner: MockElement = {
        style: { display: 'none' },
        scrollIntoView: () => undefined
    };
    const globalErrorMessage: MockElement = { textContent: '' };

    installMockDocument({
        globalErrorBanner,
        globalErrorMessage,
        modelId: createField('compatible:test-model'),
        modelName: createField('Test Model'),
        provider: createField('custom-provider'),
        baseUrl: createField('https://api.example.com/v1'),
        endpoint: createField(''),
        modelsEndpoint: createField(''),
        proxy: createField(''),
        maxInputTokens: createField('128000'),
        maxOutputTokens: createField('4096'),
        customHeader: createField(''),
        extraBody: createField(''),
        limitRpm: createField('60'),
        limitParallel: createField('1.5'),
        webSearchToolConfig: createField(''),
        nativeTools: createField('')
    });

    assert.equal(validateForm(), false);
    assert.equal(globalErrorBanner.style?.display, 'flex');
    assert.equal(globalErrorMessage.textContent, '限流配置的值必须是大于等于 0 的整数。');
});
