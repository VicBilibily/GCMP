'use strict';

const snapshot = require('./devin-model-variants.json');
if (snapshot.version !== 1 || !Array.isArray(snapshot.entries)) {
  throw new Error('Unsupported Devin native model snapshot');
}

const TARGETS = [
  { id: 'devin-gpt-6-1-sol', name: 'GPT-6.1 Sol', prefix: 'gpt-6-1-sol-', defaultUid: 'gpt-6-1-sol-high' },
  { id: 'devin-gpt-6-sol', name: 'GPT-6 Sol', prefix: 'gpt-6-sol-', defaultUid: 'gpt-6-sol-high' },
  { id: 'devin-gpt-6-luna', name: 'GPT-6 Luna', prefix: 'gpt-6-luna-', defaultUid: 'gpt-6-luna-high',
    fallbackOrigin: 'Devin public model catalog fallback; server availability may change' },
  { id: 'devin-claude-opus-5-5', name: 'Claude Opus 5.5', prefix: 'claude-opus-5-5-', defaultUid: 'claude-opus-5-5-high' },
];
// Devin's public model catalog lists these standalone Luna UIDs and prices
// (https://docs.devin.ai/desktop/models). The frozen Desktop snapshot predates
// Luna's inclusion; live GetCliModelConfigs rows supersede this fallback.
function lunaFallback(effort, order, creditMultiplier, recommended) {
  return {
    uid: 'gpt-6-luna-' + effort.toLowerCase(),
    label: 'GPT-6 Luna ' + effort + ' Thinking',
    familyLabel: 'GPT-6 Luna',
    groups: [
      { name: 'Reasoning Effort', options: [{ id: order, label: effort, flag: 1 }] },
      { name: 'Fast Mode', options: [{ id: 0, label: '', flag: 2 }] },
      { name: 'Prompt Cache Retention', options: [{ id: 1, label: '24h', flag: 2 }] },
    ],
    maxTokens: 1000000,
    creditMultiplier,
    pricing: [
      { label: 'Input', usd: 0.1, unit: '1M tokens' },
      { label: 'Cached input', usd: 0.01, unit: '1M tokens' },
      { label: 'Cache write', usd: 0.125, unit: '1M tokens' },
      { label: 'Output', usd: 0.5, unit: '1M tokens' },
    ],
    disabled: false,
    defaultInFamily: recommended,
    supportsImages: true,
  };
}
const FALLBACK_ENTRIES = snapshot.entries.concat([
  lunaFallback('Medium', 2, 5, true),
  lunaFallback('High', 3, 6, false),
]);
const GROUP_KEYS = {
  Effort: 'reasoningEffort',
  'Reasoning Effort': 'reasoningEffort',
  'Fast Mode': 'fastMode',
  Thinking: 'thinking',
  '1M Context': 'context1m',
  'Prompt Cache Retention': 'promptCacheRetention',
};
function supportedEntry(entry) {
  return typeof entry.uid === 'string' && TARGETS.some(target => entry.uid.startsWith(target.prefix));
}
let selectedEntries = new Map(FALLBACK_ENTRIES.filter(entry => supportedEntry(entry) && !entry.disabled).map(entry => [entry.uid, entry]));

function selection(entry) {
  const result = {};
  for (const group of entry.groups || []) {
    const key = GROUP_KEYS[group.name];
    if (!key) continue;
    if (!group.options || group.options.length !== 1) {
      throw new Error('Expected one selected native option for ' + entry.uid + ': ' + group.name);
    }
    const option = group.options[0];
    // Native OPTION controls encode off/on as order 0/1, without a label.
    if (option.flag === 2) {
      if (option.id !== 0 && option.id !== 1) throw new Error('Invalid native toggle: ' + entry.uid);
      result[key] = option.id === 1;
    } else {
      if (!option.label) throw new Error('Missing native option label: ' + entry.uid);
      result[key] = key === 'reasoningEffort' ? option.label.toLowerCase() : option.label;
    }
  }
  return result;
}

// The native OPTION control encodes Fast Mode as a bare 0/1 toggle with no
// labels; expose it as an explicit Standard/Fast string enum so the control is
// unambiguous in the navigation chip.
const FAST_MODE_VALUES = ['standard', 'fast'];
const FAST_MODE_LABELS = ['Standard', 'Fast'];

function normalizeFastMode(value) {
  if (value === undefined || value === null) return false;
  if (value === 'standard') return false;
  if (value === 'fast') return true;
  if (typeof value === 'boolean') return value;
  throw new Error('Invalid Fast Mode value: ' + JSON.stringify(value) +
    " (expected 'standard', 'fast', or a boolean)");
}

function rowPricing(entry) {
  const result = { input: null, output: null, cacheRead: null, cacheWrite: 0 };
  const keys = { input: 'input', output: 'output', 'cached input': 'cacheRead', 'cache write': 'cacheWrite' };
  for (const row of entry.pricing || []) {
    const key = keys[String(row.label || '').trim().toLowerCase()];
    if (key && Number.isFinite(row.usd)) result[key] = row.usd;
  }
  return result.input === null && result.output === null ? null : result;
}

/* Display-only rounding: the snapshot's f32 rates carry float noise
   (0.20000000298023224); toPrecision(7) trims the printed form without
   touching the stored rates or any billing math. */
function fmtRate(n) { return Number(Number(n).toPrecision(7)); }

function formatPricing(pricing) {
  if (!pricing) return null;
  const parts = [];
  if (pricing.input !== null) parts.push('input $' + fmtRate(pricing.input));
  if (pricing.cacheRead !== null) parts.push('cached input $' + fmtRate(pricing.cacheRead));
  if (pricing.output !== null) parts.push('output $' + fmtRate(pricing.output));
  return parts.length ? parts.join(' / ') + ' per 1M tokens' : null;
}

function effortLabel(entry) {
  for (const group of entry.groups || []) {
    if (GROUP_KEYS[group.name] === 'reasoningEffort' && group.options && group.options[0] && group.options[0].label) {
      return group.options[0].label;
    }
  }
  return null;
}

function fastModeDescription(family) {
  /* Representative row per mode: the family default's own effort first (a
     high-default family reads 'High x90 / x180', not whichever medium row
     sorts first), else the first variant of that mode. */
  const defaultEffort = selection(family.defaultEntry).reasoningEffort || null;
  const pick = (mode) => {
    const same = family.variants.filter(entry => selection(entry).fastMode === mode);
    return same.find(entry => defaultEffort && selection(entry).reasoningEffort === defaultEffort) || same[0] || null;
  };
  const parts = [];
  for (const [mode, label] of [[false, 'Standard'], [true, 'Fast']]) {
    const row = pick(mode);
    if (!row) continue;
    const detail = [effortLabel(row),
      Number.isFinite(row.creditMultiplier) ? 'credit x' + fmtRate(row.creditMultiplier) + ' multiplier' : null,
      formatPricing(rowPricing(row))].filter(Boolean).join(', ');
    parts.push(label + (detail ? ': ' + detail : ''));
  }
  return parts.join('; ');
}

function properties(family) {
  const result = {};
  const defaults = selection(family.defaultEntry);
  const groups = new Map();
  for (const entry of family.variants) {
    const values = selection(entry);
    for (const group of entry.groups || []) {
      const key = GROUP_KEYS[group.name];
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { title: group.name, values: new Map() });
      const option = group.options[0];
      const value = values[key];
      const old = groups.get(key).values.get(value);
      groups.get(key).values.set(value, {
        value, label: option.label, order: old ? Math.min(old.order, option.id) : option.id,
      });
    }
  }
  for (const [key, group] of groups) {
    const options = Array.from(group.values.values()).sort((a, b) =>
      a.order - b.order || String(a.value).localeCompare(String(b.value)));
    /* Fast Mode stays a Standard/Fast string enum even when every served
       variant shares one side (fast-only or standard-only live subsets): the
       control must remain available, and resolve() still throws for a mode
       the catalog does not carry. */
    if (key === 'fastMode') {
      result[key] = {
        type: 'string',
        title: group.title,
        default: 'standard',
        enum: FAST_MODE_VALUES.slice(),
        enumItemLabels: FAST_MODE_LABELS.slice(),
        description: fastModeDescription(family),
        group: 'navigation',
      };
      continue;
    }
    // Fixed metadata (e.g. 24h retention) is not an actionable native control.
    if (options.length < 2) continue;
    const isToggle = typeof options[0].value === 'boolean';
    result[key] = {
      type: isToggle ? 'boolean' : 'string',
      title: group.title,
      default: defaults[key],
      group: 'navigation',
    };
    if (!isToggle) {
      result[key].enum = options.map(option => option.value);
      result[key].enumItemLabels = options.map(option => option.label);
    }
  }
  return result;
}

function buildFamilies(liveEntries) {
  const live = Array.isArray(liveEntries) ? liveEntries : [];
  const families = [];
  selectedEntries = new Map(FALLBACK_ENTRIES.filter(entry => supportedEntry(entry) && !entry.disabled).map(entry => [entry.uid, entry]));
  for (const target of TARGETS) {
    const liveRows = live.filter(entry => typeof entry.uid === 'string' && entry.uid.startsWith(target.prefix));
    const source = liveRows.length ? liveRows : FALLBACK_ENTRIES.filter(entry => entry.uid.startsWith(target.prefix));
    // A live family supersedes its entire snapshot, including disabled UIDs.
    if (liveRows.length) {
      for (const uid of selectedEntries.keys()) {
        if (uid.startsWith(target.prefix)) selectedEntries.delete(uid);
      }
    }
    const variants = source.filter(entry => {
      if (entry.disabled || !Number.isFinite(entry.maxTokens) || entry.maxTokens <= 0) return false;
      try { selection(entry); return true; } catch (_) { return false; }
    });
    if (!variants.length) continue;
    for (const entry of variants) selectedEntries.set(entry.uid, entry);
    const isFast = entry => selection(entry).fastMode === true;
    // Never default to a fast/priority variant: prefer the target default UID
    // when it is a normal row, then a non-fast family default, then any
    // non-fast variant. A fast-only family keeps an explicit fast default.
    const targetDefault = variants.find(entry => entry.uid === target.defaultUid);
    const defaultEntry = (targetDefault && !isFast(targetDefault) ? targetDefault : null) ||
      variants.find(entry => entry.defaultInFamily && !isFast(entry)) ||
      variants.find(entry => !isFast(entry)) || variants[0];
    const family = {
      id: target.id,
      name: target.name,
      variantFamily: true,
      variants,
      defaultEntry,
      defaultUid: defaultEntry.uid,
      default: selection(defaultEntry).reasoningEffort || 'standard',
      effort: variants.map(entry => [
        selection(entry).reasoningEffort || 'standard', entry.label, entry.uid,
        entry.maxTokens || 0, entry.creditMultiplier,
      ]),
      maxInput: Math.min(...variants.map(entry => entry.maxTokens || 0)),
      fromCatalog: liveRows.length > 0,
      tip: 'Native effort and fast-mode variants',
    };
    if (!family.fromCatalog) family.tip += ' (' + (target.fallbackOrigin || 'Desktop snapshot fallback; server availability may change') + ')';
    families.push(family);
  }
  return families;
}

function resolve(family, configuration) {
  if (!family || !family.variantFamily) throw new Error('Expected a native variant family');
  const allowed = new Set([...Object.values(GROUP_KEYS), 'contextSize']);
  for (const key of Object.keys(configuration || {})) {
    if (!allowed.has(key)) throw new Error('Unknown Devin model configuration key: ' + key);
  }
  const defaults = selection(family.defaultEntry);
  // Fast Mode defaults to Standard even when the family default row is a
  // priority variant, so a missing field never silently inherits fast mode.
  const desired = { ...defaults, fastMode: false };
  for (const key of Object.values(GROUP_KEYS)) {
    if (configuration && Object.prototype.hasOwnProperty.call(configuration, key)) {
      desired[key] = key === 'fastMode' ? normalizeFastMode(configuration[key]) : configuration[key];
    }
  }
  const match = family.variants.find(entry => {
    const actual = selection(entry);
    const keys = new Set([...Object.keys(desired), ...Object.keys(actual)]);
    return Array.from(keys).every(key => actual[key] === desired[key]);
  });
  if (!match) {
    throw new Error('Devin ' + family.name + ' has no native variant for ' +
      JSON.stringify(desired) + '. Choose a supported Effort/Fast Mode combination.');
  }
  return match.uid;
}

function entryFor(uid) {
  return selectedEntries.get(uid) || null;
}

function creditMultiplier(uid) {
  const entry = entryFor(uid);
  return entry && Number.isFinite(entry.creditMultiplier) ? entry.creditMultiplier : null;
}

function displayPricing(uid) {
  const entry = entryFor(uid);
  return entry ? rowPricing(entry) : null;
}

function billingPricing(uid) {
  return displayPricing(uid);
}

function contextInput(family, outputTokens) {
  const total = Number(family.maxInput);
  if (!Number.isFinite(total) || total <= outputTokens) throw new Error('Invalid native model context budget');
  return total - outputTokens;
}

module.exports = { TARGETS, GROUP_KEYS, buildFamilies, properties, resolve, selection,
  entryFor, creditMultiplier, displayPricing, billingPricing, contextInput, normalizeFastMode };
