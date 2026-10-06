/* GCMP Devin provider (direct HTTP, no bridge process) - injected by vscode-ai-toolkit.ps1 -Task devin.
 * Transport: Connect-protobuf RPC  POST /exa.api_server_pb.ApiServerService/GetChatMessage
 *           (application/connect+proto) against the Devin/Windsurf API server.
 * Credential: `devin auth login` OAuth file (credentials.toml -> windsurf_api_key),
 *             then the Devin Desktop session store, then the gcmp.devin.apiKey setting.
 */
(function () {
  'use strict';
  if (globalThis.__gcmpDevinBridge) return;
  globalThis.__gcmpDevinBridge = { version: 2, transport: 'http' };

  var vscode = require('vscode');
  var cp = require('child_process');
  var fs = require('fs');
  var os = require('os');
  var nodePath = require('path');
  var nativeModels = require('./devin-models.js');
  var crypto = require('crypto');
  var https = require('https');
  var http = require('http');

  var VENDOR = 'gcmp.devin';
  var SERVER_URL_DEFAULT = 'https://server.codeium.com';
  var CHAT_PATH = '/exa.api_server_pb.ApiServerService/GetChatMessage';
  var CATALOG_PATH = '/exa.api_server_pb.ApiServerService/GetCliModelConfigs';
  var SEAT_SERVICE = 'exa.seat_management_pb.SeatManagementService';
  var CATALOG_TTL_MS = 60 * 60 * 1000;
  var REQUEST_TIMEOUT_MS = 60000;
  var CHAT_TTFB_TIMEOUT_MS = 300000;
  var RETRY_LIMIT = 3;
  var MAX_RATE_LIMIT_RETRIES = 2;
  var RETRY_BASE_MS = 500;
  var RETRY_MAX_MS = 8000;
  var CLI_REL = ['resources', 'app', 'extensions', 'windsurf', 'devin', 'bin', 'devin.exe'];
  var CRED_TTL_MS = 5 * 60 * 1000;
  var CLI_VERSION = '3000.10.23';

  var SWE_FAMILIES = [
    {
      id: 'devin-swe-2', name: 'SWE-2', tip: 'Devin SWE-2 agent model',
      effort: [['medium', 'Medium', 'swe-2-medium'], ['high', 'High', 'swe-2-high'], ['max', 'Max', 'swe-2-max']],
      default: 'max',
    },
    {
      id: 'devin-swe-1-7', name: 'SWE-1.7', tip: 'Devin SWE-1.7',
      effort: [['medium', 'Medium', 'swe-1-7-medium'], ['max', 'Max', 'swe-1-7']],
      default: 'max',
    },
    {
      id: 'devin-swe-1-7-lightning', name: 'SWE-1.7 Lightning', tip: 'Devin SWE-1.7 Lightning (fast)',
      effort: [['medium', 'Medium', 'swe-1-7-lightning-medium'], ['max', 'Max', 'swe-1-7-lightning']],
      default: 'max',
    },
    {
      id: 'devin-swe-1-6', name: 'SWE-1.6', tip: 'Devin SWE-1.6',
      effort: [['standard', 'Standard', 'swe-1-6'], ['fast', 'Fast', 'swe-1-6-fast']],
      default: 'standard',
    },
    {
      id: 'devin-glm-5-3', name: 'GLM-5.3', tip: 'Devin GLM-5.3 (Z.ai, 1M ctx)',
      effort: [['low', 'Low', 'glm-5-3-low'], ['high', 'High', 'glm-5-3-high'], ['max', 'Max', 'glm-5-3-max']],
      default: 'max',
      /* the static GLM rows carry no per-row ceilings; the observed catalog window is 1M */
      maxInput: 1000000,
    },
  ];
  var CONTEXT_PRESETS = [[336000, '400K'], [536000, '600K'], [736000, '800K'], [936000, '1M']];
  /* enum value = INPUT budget (what maxInputTokens reports), label = input+output total.
     The catalog's 262000 is a floor label, not the real window - the swe-2 backend serves
     single prompts past 1M input tokens, so these tiers are honest budgets. 600K is the
     default tier. Changing the pick re-fires the model info so VS Code re-reads it. */
  var CONTEXT_DEFAULT = CONTEXT_PRESETS[1][0];
  var REPORTED_WINDOW = CONTEXT_DEFAULT;
  var MAX_OUTPUT_TOKENS = 64000;
  var COMPACTION_OUTPUT_TOKENS = 64000;
  var PROMPT_CACHE_TTL_MS = 300000;

  /** USD per 1M tokens from docs.devin.ai/desktop/models; Luna has a cache-write rate. */
  var MODEL_PRICING = {
    'swe-2-max': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
    'swe-2-high': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
    'swe-2-medium': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
    'swe-1-7': { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    'swe-1-7-medium': { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    'swe-1-7-lightning': { input: 2.5, output: 12.5, cacheRead: 1, cacheWrite: 0 },
    'swe-1-7-lightning-medium': { input: 2.5, output: 12.5, cacheRead: 1, cacheWrite: 0 },
    'swe-1-6': { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    'swe-1-6-fast': { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    /* docs.devin.ai/desktop/models - GLM-5.3 (Z.ai): same rates for low/high/max */
    'glm-5-3-low': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    'glm-5-3-high': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    'glm-5-3-max': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
     'gpt-6-luna-medium': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
     'gpt-6-luna-high': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  };

  function pricingFor(modelId) {
    /* Fusion is unsupported by this provider; never estimate its price. */
    if (String(modelId).indexOf('fusion-') === 0) { return null; }
    var live = catalogPricing(modelId);
    if (live) { return live; }
    var native = nativeModels.billingPricing(modelId);
    if (native) { return { input: native.input, output: native.output, cacheRead: native.cacheRead, cacheWrite: native.cacheWrite, credits: {} }; }
    return MODEL_PRICING[modelId] || null;
  }

  /* ------------------------------------------------------------------ *
   * transport (mirrors the Devin CLI client: application/proto unary,
   * keep-alive agent, retry budget, compressed responses)
   * ------------------------------------------------------------------ */

  var keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 8, timeout: 300000 });
  var keepAliveAgentHttp = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 8, timeout: 300000 });

  /** A stalled or half-closed connection must not be reused for the next attempt. */
  function dropPooledSockets() {
    try { keepAliveAgent.destroy(); } catch (e) { /* noop */ }
    try { keepAliveAgentHttp.destroy(); } catch (e) { /* noop */ }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function headerOf(headers, name) {
    if (!headers) { return null; }
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === name) { return headers[keys[i]]; }
    }
    return null;
  }

  function rpcError(status, detail, retryable) {
    var err = new Error('HTTP ' + status + (detail ? (': ' + detail) : ''));
    err.status = status;
    err.retryable = !!retryable;
    return err;
  }

  function isRetryableStatus(status) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }

  function isRetryableNetwork(err) {
    var code = err && err.code;
    return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
      code === 'EAI_AGAIN' || code === 'EPIPE' || code === 'ENOTFOUND' ||
      /socket hang up/i.test(String(err && err.message)) || /request timeout/i.test(String(err && err.message));
  }

  /** DNS / connect failures get a longer budget: they are usually a flaky VPN/proxy, not the API. */
  function isDnsFailure(err) {
    var code = err && err.code;
    return code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ECONNRESET';
  }

  /** Pass-through: surface the transport error exactly as it came in. */
  function friendlyNetworkError(err) {
    return err;
  }

  function retryDelayMs(err, attempt, headers) {
    var after = headerOf(headers, 'retry-after');
    if (after) {
      var seconds = Number(after);
      if (isFinite(seconds) && seconds > 0) { return Math.min(seconds * 1000, 60000); }
      var when = Date.parse(after);
      if (!isNaN(when)) { return Math.max(0, Math.min(when - Date.now(), 60000)); }
    }
    var delay = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_MAX_MS);
    return delay + Math.floor(Math.random() * 250);
  }

  /** Retry budget shared by every call: only failures before any useful output are retried. */
  function withRetry(attemptFn, label, beforeRetry) {
    var attempt = 0;
    function run() {
      return attemptFn().catch(function (err) {
        var retryable = (err && err.status !== undefined) ? isRetryableStatus(err.status) : isRetryableNetwork(err);
        if (!retryable || attempt >= RETRY_LIMIT) { throw err; }
        var delay = retryDelayMs(err, attempt, err.headers);
        attempt++;
        logLine('retry ' + label + ' #' + attempt + ' in ' + delay + 'ms (' + (err && err.message) + ')');
        if (beforeRetry) { beforeRetry(err); }
        return sleep(delay).then(run);
      });
    }
    return run();
  }

  function inflateBody(body, encoding) {
    var enc = String(encoding || '').toLowerCase();
    var zlib = null;
    try { zlib = require('zlib'); } catch (e) { return body; }
    try {
      if (enc.indexOf('gzip') >= 0) { return zlib.gunzipSync(body); }
      if (enc.indexOf('br') >= 0) { return zlib.brotliDecompressSync(body); }
      if (enc.indexOf('deflate') >= 0) { return zlib.inflateSync(body); }
    } catch (e) { logLine('inflate failed: ' + (e && e.message)); }
    return body;
  }

  /** Unary RPC on the api server (application/proto, like the CLI client). */
  function rpcUnaryPath(credential, servicePath, method, payload, extraHeaders) {
    var host = SERVER_URL_DEFAULT;
    var port = null;
    var basePath = '';
    var scheme = 'https';
    try {
      var u = new URL(credential.serverUrl || SERVER_URL_DEFAULT);
      host = u.hostname;
      port = u.port || null;
      scheme = u.protocol === 'http:' ? 'http' : 'https';
      basePath = u.pathname.replace(/\/$/, '');
    } catch (e) { /* default host */ }
    var transport = scheme === 'http' ? http : https;
    var body = payload || Buffer.alloc(0);
    return withRetry(function () {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var headers = {
          'Content-Type': 'application/proto',
          'Connect-Protocol-Version': '1',
          'Authorization': 'Basic ' + credential.apiKey + '-' + credential.apiKey,
          'Accept': 'application/proto',
          'Accept-Encoding': 'gzip, br, deflate',
          'sentry-trace': crypto.randomBytes(16).toString('hex') + '-' + crypto.randomBytes(8).toString('hex') + '-1',
          'Content-Length': body.length,
        };
        if (extraHeaders) { for (var k in extraHeaders) { headers[k] = extraHeaders[k]; } }
        var req = transport.request({
          host: host,
          port: port || undefined,
          path: basePath + '/' + servicePath + '/' + method,
          method: 'POST',
          agent: scheme === 'http' ? keepAliveAgentHttp : keepAliveAgent,
          headers: headers,
        }, function (res) {
          var chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          res.on('end', function () {
            if (settled) { return; }
            settled = true;
            var buf = Buffer.concat(chunks);
            if (res.statusCode !== 200) {
              var err = rpcError(res.statusCode, buf.toString('utf8').slice(0, 300), isRetryableStatus(res.statusCode));
              err.headers = res.headers;
              reject(err);
              return;
            }
            resolve(inflateBody(buf, res.headers['content-encoding']));
          });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, function () {
          /* Tag the timeout with ETIMEDOUT so withRetry treats it as retryable (a bare Error
             carries no code and isRetryableNetwork would drop it after a single 60s hang). */
          try {
            var timeoutErr = new Error('request timeout after ' + REQUEST_TIMEOUT_MS + 'ms');
            timeoutErr.code = 'ETIMEDOUT';
            req.destroy(timeoutErr);
          } catch (e) { /* noop */ }
        });
        req.on('error', function (e) { if (!settled) { settled = true; reject(e); } });
        req.end(body);
      });
    }, method);
  }

  /** Legacy shorthand: api_server_pb service. */
  function rpcUnary(credential, method, payload) {
    return rpcUnaryPath(credential, 'exa.api_server_pb.ApiServerService', method, payload);
  }

  /* ------------------------------------------------------------------ *
   * model catalog (GetCliModelConfigs) - the same data the CLI/Desktop uses
   * ------------------------------------------------------------------ */

  var catalogState = { at: 0, entries: [], byUid: {}, families: null, error: null, loading: null };

  function catalogEntryFrom(buf) {
    var f = parseFields(buf);
    var pick = function (field) { for (var i = 0; i < f.length; i++) { if (f[i].field === field) { return f[i]; } } return null; };
    var strAt = function (field) { var h = pick(field); return h && h.bytes ? h.bytes.toString('utf8') : null; };
    var numAt = function (field) { var h = pick(field); return h && h.varint !== undefined ? h.varint : null; };
    var floatAt = function (field) { var h = pick(field); return h && h.bytes && h.bytes.length === 4 ? h.bytes.readFloatLE(0) : null; };
    var supportsImagesField = numAt(5);
    var entry = {
      uid: strAt(22),
      label: strAt(1),
      creditMultiplier: floatAt(3),
      disabled: !!numAt(4),
      supportsImages: supportsImagesField === null ? undefined : supportsImagesField !== 0,
      maxTokens: numAt(18),
      familyLabel: null,
      groups: [],
      pricing: null,
      defaultInFamily: !!numAt(31),
    };
    var family = pick(30);
    if (family && family.bytes) {
      var ff = parseFields(family.bytes);
      for (var i = 0; i < ff.length; i++) {
        if (ff[i].field === 1 && ff[i].bytes) { entry.familyLabel = ff[i].bytes.toString('utf8'); }
        else if (ff[i].field === 2 && ff[i].bytes) {
          var gf = parseFields(ff[i].bytes);
          var group = { name: null, options: [] };
          for (var g = 0; g < gf.length; g++) {
            if (gf[g].field === 1 && gf[g].bytes) { group.name = gf[g].bytes.toString('utf8'); }
            else if (gf[g].field === 2 && gf[g].bytes) {
              var of = parseFields(gf[g].bytes);
              var opt = { id: 0, label: '', flag: 0 };
              for (var o = 0; o < of.length; o++) {
                if (of[o].field === 1) {
                  if (of[o].varint === undefined) { throw new Error('catalog option order/id field #1 is not varint'); }
                  opt.id = of[o].varint;
                }
                else if (of[o].field === 2) {
                  /* bytes alone is not proof of wire 2: fixed32/fixed64 fields carry
                     .bytes too - a wrong wire type on a known field must reject */
                  if (of[o].wire !== 2 || !of[o].bytes) { throw new Error('catalog option label field #2 is not length-delimited'); }
                  opt.label = of[o].bytes.toString('utf8');
                }
                else if (of[o].field === 3) {
                  if (of[o].varint === undefined) { throw new Error('catalog option flag field #3 is not varint'); }
                  opt.flag = of[o].varint;
                }
              }
              group.options.push(opt);
            }
          }
          entry.groups.push(group);
        }
      }
    }
    for (i = 0; i < f.length; i++) {
      if (f[i].field !== 32 || !f[i].bytes) { continue; }
      var rf = parseFields(f[i].bytes);
      var row = { label: null, usd: null, credits: null, unit: null };
      for (var r = 0; r < rf.length; r++) {
        if (rf[r].field === 1 && rf[r].bytes) { row.label = rf[r].bytes.toString('utf8'); }
        else if (rf[r].field === 2 && rf[r].bytes && rf[r].bytes.length === 4) { row.usd = rf[r].bytes.readFloatLE(0); }
        else if (rf[r].field === 3 && rf[r].bytes) { row.unit = rf[r].bytes.toString('utf8'); }
        else if (rf[r].field === 5 && rf[r].bytes && rf[r].bytes.length === 4) { row.credits = rf[r].bytes.readFloatLE(0); }
      }
      if (!entry.pricing) { entry.pricing = []; }
      entry.pricing.push(row);
    }
    return entry;
  }

  function decodeCatalog(buf) {
    var out = [];
    var top = parseFields(buf);
    for (var i = 0; i < top.length; i++) {
      if (top[i].field === 1 && top[i].bytes) {
        var entry = catalogEntryFrom(top[i].bytes);
        if (entry.uid) { out.push(entry); }
      }
    }
    return out;
  }

  function catalogEnabled() { return cfgGet('modelCatalog', true) !== false; }

  function loadCatalog(credential, force) {
    if (!catalogEnabled()) { return Promise.resolve(null); }
    var now = Date.now();
    if (!force && catalogState.entries.length && (now - catalogState.at) < CATALOG_TTL_MS) {
      return Promise.resolve(catalogState);
    }
    if (catalogState.loading) { return catalogState.loading; }
    var meta = buildMetadata(credential.apiKey, credential.serverUrl || SERVER_URL_DEFAULT);
    var payload = lenField(1, meta);
    var loadingState = catalogState;
    var promise = rpcUnary(credential, 'GetCliModelConfigs', payload).then(function (buf) {
      if (catalogState !== loadingState) { return null; }
      var entries = decodeCatalog(buf);
      if (!entries.length) { throw new Error('catalog response had no entries'); }
      catalogState = { at: Date.now(), entries: entries, byUid: {}, families: null, error: null, loading: null };
      for (var i = 0; i < entries.length; i++) { catalogState.byUid[entries[i].uid] = entries[i]; }
      catalogState.families = catalogFamilies(entries);
      catalogState.error = null;
      logLine('catalog: ' + entries.length + ' models, ' + catalogState.families.length + ' swe families (' +
        catalogState.families.map(function (f) { return f.name + '/' + f.effort.length; }).join(', ') + ')');
      /* debug: dump every uid/label/window so we can find the non-SWE backends the filter drops */
      if (globalThis.__gcmpDevinDebug) {
        logLine('catalog all uids: ' + entries.map(function (e) { return e.uid + '[' + (e.maxTokens || 0) + ']'; }).join(', '));
      }
      return catalogState;
    }).catch(function (err) {
      if (catalogState !== loadingState) { return null; }
      catalogState.error = (err && err.message) || String(err);
      catalogState.loading = null;
      logErr('catalog fetch failed: ' + catalogState.error);
      return null;
    });
    catalogState.loading = promise;
    return promise;
  }

  var SWE_FAMILY_ORDER = ['SWE-2', 'SWE-1.7', 'SWE-1.7 Lightning', 'SWE-1.6'];
  /* Newest non-SWE backends the CLI catalog already serves - the old /swe-/ filter dropped these. */
  var EXTRA_UIDS = [
    'gpt-6-astra-max', 'gpt-6-astra-high', 'gpt-6-astra-low',
    'claude-opus-5-max', 'claude-opus-5-high', 'claude-opus-5-low',
    'claude-fable-5-1-max', 'claude-fable-5-1-high', 'claude-fable-5-1-low',
    'glm-5-3-max', 'glm-5-3-high', 'glm-5-3-low',
  ];
  var EFFORT_RANK = { 'minimal': 0, 'none': 0, 'off': 0, 'low': 1, 'standard': 2, 'medium': 2, 'high': 3, 'xhigh': 4, 'max': 5, 'fast': 6, 'lightning': 6 };

  function effortKeyOf(entry) {
    var group = entry.groups[0];
    var label = (group && group.options[0] && group.options[0].label) || '';
    if (!label) {
      var m = /(none|low|medium|high|xhigh|max|fast|lightning|standard|minimal)\s*$/i.exec(String(entry.label || '').replace(/^swe[-\d.]*\s*/i, ''));
      label = m ? m[1] : 'standard';
    }
    return label.toLowerCase();
  }

  /** Uids owned by the native variant families (devin-models prefixes) - the generic
     swe/extra flat-grouping loops must not re-group them into single-effort families. */
  function nativeUid(uid) {
    uid = String(uid || '');
    for (var t = 0; t < nativeModels.TARGETS.length; t++) {
      if (uid.indexOf(nativeModels.TARGETS[t].prefix) === 0) { return true; }
    }
    return false;
  }

  function catalogFamilies(entries) {
    var groups = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (/^swe-/.test(e.uid) && !nativeUid(e.uid)) {
        var name = e.familyLabel || e.uid;
        groups[name] = groups[name] || [];
        groups[name].push(e);
      }
    }
    /* pull in the newest non-SWE backends as single-model families (the catalog carries them flat) */
    for (i = 0; i < entries.length; i++) {
      var e2 = entries[i];
      if (/^swe-/.test(e2.uid)) { continue; }
      if (nativeUid(e2.uid)) { continue; }
      if (EXTRA_UIDS.indexOf(e2.uid) < 0) { continue; }
      var famName = e2.familyLabel || e2.uid.replace(/-(?:max|high|low|medium|xhigh|minimal|none|fast|lightning|standard|priority)$/i, '').replace(/^(.*?)-[0-9]+-?(.*)$/, function (m, a, b) { return (a + '-' + b).toUpperCase(); });
      groups[famName] = groups[famName] || [];
      groups[famName].push(e2);
    }
    var names = Object.keys(groups);
    names.sort(function (a, b) {
      var ia = SWE_FAMILY_ORDER.indexOf(a), ib = SWE_FAMILY_ORDER.indexOf(b);
      ia = ia < 0 ? 99 : ia; ib = ib < 0 ? 99 : ib;
      return ia - ib || a.localeCompare(b);
    });
    var families = [];
    for (i = 0; i < names.length; i++) {
      var name2 = names[i];
      var rows = groups[name2].slice();
      rows.sort(function (a, b) {
        var ra = EFFORT_RANK[effortKeyOf(a)], rb = EFFORT_RANK[effortKeyOf(b)];
        ra = ra === undefined ? 50 : ra; rb = rb === undefined ? 50 : rb;
        return ra - rb || String(a.label).localeCompare(String(b.label));
      });
      var effort = [];
      var maxInput = 0;
      var familyMaxInput = 0;
      for (var r = 0; r < rows.length; r++) {
        effort.push([effortKeyOf(rows[r]), String(rows[r].label).replace(/^SWE-[\d.]+\s*/i, '') || effortKeyOf(rows[r]), rows[r].uid, rows[r].maxTokens || 0, rows[r].creditMultiplier]);
        if ((rows[r].maxTokens || 0) > familyMaxInput) { familyMaxInput = rows[r].maxTokens || 0; }
      }
      /* 600K+64K window for the newest backends (1000000-token catalog window), 536K+64K otherwise */
      maxInput = familyMaxInput || maxInput;
      var dflt = 'max';
      var has = function (key) { for (var k = 0; k < effort.length; k++) { if (effort[k][0] === key) { return true; } } return false; };
      if (!has(dflt)) { dflt = has('standard') ? 'standard' : effort[effort.length - 1][0]; }
      families.push({
        id: 'devin-' + name2.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, ''),
        name: name2,
        tip: 'Devin ' + name2 + ' (catalog)',
        effort: effort,
        default: dflt,
        maxInput: maxInput,
        fromCatalog: true,
      });
    }
    /* the native variant families (live catalog rows when served, snapshot otherwise)
       append after the generic flat families */
    families = families.concat(nativeModels.buildFamilies(entries));
    return families;
  }

  function catalogPricing(uid) {
    var entry = catalogState.byUid[uid];
    if (!entry || !entry.pricing) { return null; }
    var out = { input: null, output: null, cacheRead: null,
      cacheWrite: (MODEL_PRICING[uid] && MODEL_PRICING[uid].cacheWrite) || 0, credits: {} };
    for (var i = 0; i < entry.pricing.length; i++) {
      var row = entry.pricing[i];
      var label = String(row.label || '').toLowerCase();
      /* sidekick rate rows and rate-less rows must never overwrite the lead rates */
      if (label.indexOf('sidekick ') === 0) { continue; }
      if (row.usd === null || row.usd === undefined) { continue; }
      if (label.indexOf('cache write') >= 0) { out.cacheWrite = row.usd; }
      else if (label.indexOf('cached') >= 0 || label.indexOf('cache') >= 0) { out.cacheRead = row.usd; }
      else if (label.indexOf('input') >= 0) { out.input = row.usd; }
      else if (label.indexOf('output') >= 0) { out.output = row.usd; }
      if (row.credits) {
        var priceBucket = label.indexOf('cache write') >= 0 ? 'cacheWrite' :
          ((label.indexOf('cached') >= 0 || label.indexOf('cache') >= 0) ? 'cacheRead' : (label.indexOf('output') >= 0 ? 'output' : 'input'));
        out.credits[priceBucket] = row.credits;
      }
    }
    if (out.input === null && out.output === null) { return null; }
    return out;
  }

  function catalogMeta(uid) {
    var entry = catalogState.byUid[uid];
    if (!entry) {
      var nativeEntry = nativeModels.entryFor(uid);
      if (!nativeEntry) { return null; }
      return {
        label: nativeEntry.label,
        maxTokens: nativeEntry.maxTokens,
        creditMultiplier: nativeEntry.creditMultiplier,
        family: nativeEntry.familyLabel,
      };
    }
    return {
      label: entry.label,
      maxTokens: entry.maxTokens,
      creditMultiplier: entry.creditMultiplier,
      family: entry.familyLabel,
    };
  }


  var bootFile = null;
  function bootLog(msg) {
    try {
      /* file mirror is opt-in (gcmp.devin.logToFile): the unconditional append grew the log
         to tens of MB on %TEMP% - the output channel stays the primary log */
      if (cfgGet('logToFile', false) !== true) { return; }
      if (!bootFile) { bootFile = nodePath.join(os.tmpdir(), 'gcmp-devin.log'); }
      fs.appendFileSync(bootFile, '[' + new Date().toISOString() + '] ' + msg + '\n');
    } catch (e) { /* noop */ }
  }
  bootLog('module load pid=' + process.pid);

  var channel = null;
  function out() {
    if (!channel) { channel = vscode.window.createOutputChannel('GCMP - Devin'); }
    return channel;
  }
  function logLine(msg) {
    try { out().appendLine('[' + new Date().toISOString().slice(11, 19) + '] ' + msg); } catch (e) { /* noop */ }
    bootLog(msg);
  }
  function logErr(msg) { logLine('ERROR ' + msg); }

  function cfg() {
    try { return vscode.workspace.getConfiguration('gcmp.devin'); } catch (e) { return { get: function () { return undefined; } }; }
  }
  function cfgGet(key, dflt) {
    var v = cfg().get(key);
    return (v === undefined || v === null || v === '') ? dflt : v;
  }

  /* ------------------------------------------------------------------ *
   * protobuf / Connect helpers
   * ------------------------------------------------------------------ */

  function varint(n) {
    var out = [];
    var v = BigInt(n);
    while (v > 127n) { out.push(Number((v & 127n) | 128n)); v >>= 7n; }
    out.push(Number(v));
    return Buffer.from(out);
  }
  function tag(field, wire) { return varint((field << 3) | wire); }
  function lenField(field, payload) { return Buffer.concat([tag(field, 2), varint(payload.length), payload]); }
  function strField(field, s) { return lenField(field, Buffer.from(String(s), 'utf8')); }
  function varintField(field, v) { return Buffer.concat([tag(field, 0), varint(v)]); }
  function doubleField(field, d) { var b = Buffer.alloc(8); b.writeDoubleLE(d); return Buffer.concat([tag(field, 1), b]); }

  function readVarint(buf, i) {
    var shift = 0n, result = 0n;
    /* a uint64 varint is at most 10 bytes; reading past the buffer or past byte 10 means
       the frame is malformed - fail loudly instead of silently consuming garbage */
    for (var n = 0; n < 10; n++) {
      if (i >= buf.length) { throw new Error('truncated protobuf varint at offset ' + i); }
      var b = buf[i++];
      /* the 10th byte may only carry bit 0 (uint64 tops out at 2^64-1); anything more -
         including a continuation bit - is a malformed frame. Decoding it anyway would let
         BigInt.asIntN(64,...) silently wrap the value downstream. */
      if (n === 9 && (b & 0xfe) !== 0) {
        throw new Error('protobuf varint exceeds uint64 range at offset ' + (i - 1));
      }
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) { return [Number(result), i, result]; }
      shift += 7n;
    }
    throw new Error('protobuf varint exceeds 10 bytes (not a uint64) at offset ' + (i - 10));
  }

  /* int64 response fields can exceed 2^53 - keep the raw bigint and only narrow to a Number
     when the value is exactly representable; larger values stay an exact decimal string so
     the usage log never shows a silently rounded counter. */
  function int64Safe(v) {
    var b = typeof v === 'bigint' ? v : BigInt(v);
    var max = BigInt(Number.MAX_SAFE_INTEGER), min = -max;
    if (b <= max && b >= min) { return Number(b); }
    return b.toString(10);
  }

  /* settles a stream the user cancelled: VS Code's own CancellationError when the vscode
     namespace is in scope, otherwise a plain Error flagged non-retryable either way. */
  function cancellationError() {
    var e = (typeof vscode !== 'undefined' && vscode.CancellationError)
      ? new vscode.CancellationError()
      : new Error('cancelled');
    e.cancelled = true;
    e.retryable = false;
    return e;
  }

  function parseFields(buf) {
    var out = [];
    var i = 0;
    while (i < buf.length) {
      var t = readVarint(buf, i); i = t[1];
      var field = Math.floor(t[0] / 8), wire = t[0] & 7;
      if (t[0] > 0xffffffff || !field || field > 0x1fffffff) { throw new Error('invalid protobuf field tag ' + t[0] + ' at offset ' + i); }
      if (wire === 0) { var v = readVarint(buf, i); i = v[1]; out.push({ field: field, wire: wire, varint: v[0], varintBig: v[2] }); }
      else if (wire === 2) {
        var ln = readVarint(buf, i); i = ln[1];
        if (ln[0] > buf.length - i) { throw new Error('length-delimited field #' + field + ' overruns the frame (' + ln[0] + 'B declared, ' + (buf.length - i) + 'B left)'); }
        out.push({ field: field, wire: wire, bytes: buf.slice(i, i + ln[0]) }); i += ln[0];
      }
      else if (wire === 5) {
        if (buf.length - i < 4) { throw new Error('truncated fixed32 field #' + field + ' at offset ' + i); }
        out.push({ field: field, wire: wire, bytes: buf.slice(i, i + 4) }); i += 4;
      }
      else if (wire === 1) {
        if (buf.length - i < 8) { throw new Error('truncated fixed64 field #' + field + ' at offset ' + i); }
        out.push({ field: field, wire: wire, bytes: buf.slice(i, i + 8) }); i += 8;
      }
      else { throw new Error('unsupported protobuf wire type ' + wire + ' on field #' + field); }
    }
    return out;
  }

  /** Connect end-stream JSON: {error:{code,message,...}} or plain metadata -> Error or null. */
  function connectTrailerError(text) {
    if (!text || text.indexOf('{') < 0) { return null; }
    var obj = null;
    try { obj = JSON.parse(text); } catch (e) { return null; }
    if (!obj || !obj.error) { return null; }
    var err = new Error('Devin stream error' + (obj.error.code ? (' [' + obj.error.code + ']') : '') + ': ' + (obj.error.message || 'unknown'));
    err.streamError = obj.error;
    err.retryable = obj.error.code === 'unavailable' || obj.error.code === 'deadline_exceeded' || obj.error.code === 'resource_exhausted';
    /* an over-long prompt cannot be fixed by re-sending it (message stays the server's own) */
    if (obj.error.code === 'invalid_argument' && /too long/i.test(String(obj.error.message || ''))) {
      err.retryable = false;
    }
    /* the limiter states when it resets; wait that long instead of hammering it */
    if (obj.error.code === 'resource_exhausted') {
      var reset = /reset in (\d+)\s*second/i.exec(String(obj.error.message || ''));
      if (reset) { err.retryAfterMs = Math.min(60000, (Number(reset[1]) + 1) * 1000); }
    }
    return err;
  }

  function envelope(payload) {
    var head = Buffer.alloc(5);
    head.writeUInt8(0, 0);
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  }

  var fingerprint = null;
  function deviceFingerprint() {
    if (!fingerprint) {
      try {
        var saved = cfgGet('deviceFingerprint', '');
        if (saved) { fingerprint = saved; }
        else {
          /* CLI/Desktop send 366 random bytes as hex (732 chars) - match that shape */
          fingerprint = crypto.randomBytes(366).toString('hex');
          try { cfg().update('deviceFingerprint', fingerprint, true); } catch (e) { /* keep in memory */ }
        }
      } catch (e) { fingerprint = crypto.randomBytes(366).toString('hex'); }
    }
    return fingerprint;
  }

  function buildMetadata(token, host) {
    var osName = process.platform === 'win32' ? 'windows' : process.platform;
    return Buffer.concat([
      strField(1, 'devin-cli'),
      strField(2, CLI_VERSION),
      strField(3, token),
      strField(4, 'en'),
      strField(5, osName),
      strField(7, CLI_VERSION),
      strField(12, 'chisel'),
      strField(28, 'chisel'),
      strField(31, deviceFingerprint()),
    ]);
  }

  var TOOL_DESC_LIMIT = 0;        // the server needs the real schema, so descriptions ship full
  var SCHEMA_LIMIT = 0;           // the server needs the real schema, so it ships full
  var TOOL_RESULT_LIMIT = 0;          // settings gcmp.devin.toolResultLimit (0 = send the full result, like the CLI)
  var STALL_TIMEOUT_MS = 120000;      // settings gcmp.devin.stallTimeoutMs (0 = watch, never abort)
  var STALL_WARN_MS = 20000;
  /* The assistant echo (thinking + sealed signature) must stay attached to every turn that is
     still in the conversation: dropping it for one message rewrites the prompt mid-history and
     the server can only reuse the prefix in front of it. The cap is therefore a memory safety
     valve far above any real conversation, not a sliding window. */
  var ASSISTANT_META_LIMIT = 512;
  /* Which assistant turns carry #11/#12/#18 (`always` | `newest` | `never`). The sealed signature
     is 8-19 KB per reasoning turn, so `always` costs several thousand tokens per turn of context;
     `newest` keeps the reasoning state of the turn we continue from and drops the rest. */
  var REASONING_ECHO = 'always';
  /* VS Code forwards terminal output as user notifications (100 KB+ dumps); keep head + tail. */
  var TERMINAL_NOTIFY_LIMIT = 8000;

  /** 0 disables the budget (send exactly what the caller supplied, like the CLI does). */
  function budget(key, dflt) {
    var v = cfgGet(key, dflt);
    var n = Number(v);
    return isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
  }

  function reasoningEchoMode() {
    var mode = String(cfgGet('reasoningEcho', REASONING_ECHO) || REASONING_ECHO).toLowerCase();
    return (mode === 'always' || mode === 'never' || mode === 'newest') ? mode : REASONING_ECHO;
  }

  /** Terminal notifications arrive as huge user messages; keep the head and the (useful) tail. */
  function trimNotification(text, limit) {
    var s = String(text || '');
    if (!limit || s.length <= limit) { return s; }
    if (s.indexOf('[Terminal ') !== 0 || s.indexOf(' notification:') < 0) { return s; }
    var head = Math.max(400, Math.round(limit * 0.2));
    var tail = Math.max(400, limit - head);
    var out = s.slice(0, head) + '\n...[terminal output trimmed: ' + (s.length - limit) + ' chars dropped]...\n' + s.slice(s.length - tail);
    logLine('terminal notification trimmed: ' + s.length + ' -> ' + out.length + ' chars (terminalNotificationLimit=' + limit + ')');
    return out;
  }

  function compactText(value, limit) {
    var s = String(value || '');
    if (!limit || s.length <= limit) { return s; }
    var cut = limit;
    var nl = s.lastIndexOf('\n', cut);
    if (nl > cut * 0.6) { cut = nl; }
    /* never split a surrogate pair: keep the model from seeing mojibake */
    if (cut > 0 && cut < s.length) {
      var code = s.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) { cut -= 1; }
    }
    return s.slice(0, cut) + '\n…[truncated ' + (s.length - cut) + ' chars]';
  }

  /* Last-ditch minimal schema, kept for callers that need an unparseable-result fallback;
     schemaString itself never substitutes this for a valid source schema. */
  var SCHEMA_MIN_JSON = '{"type":"object","properties":{},"additionalProperties":true}';

  /* Documentation-only keys: dropping these never changes what the schema validates.
     Structural/validation keys ($id, $schema, $ref, $defs, required, properties,
     additionalProperties, allOf/oneOf/anyOf, enums, etc.) are always preserved. */
  var SCHEMA_DOC_KEYS = { title: true, '$comment': true, examples: true };
  var SCHEMA_ANNOTATION_KEYS = { description: true, 'default': true };
  /* Keyword context: which child positions hold schemas, maps of schemas, or
     arrays of schemas. Only schema-position objects get annotation keys dropped;
     everything else (const/enum/default/examples payloads, custom extensions,
     unknown keywords) is data and is preserved verbatim. */
  var SCHEMA_MAP_KEYS = { properties: true, '$defs': true, definitions: true, patternProperties: true, dependentSchemas: true };
  var SCHEMA_CHILD_KEYS = { additionalProperties: true, unevaluatedProperties: true, propertyNames: true, contains: true, 'not': true, 'if': true, then: true, 'else': true, additionalItems: true, contentSchema: true };
  var SCHEMA_ARRAY_KEYS = { prefixItems: true, allOf: true, anyOf: true, oneOf: true };
  var SCHEMA_MAX_DEPTH = 24; // safety bound only: beyond this the subtree is kept verbatim, never nulled

  /* Own enumerable keys including an own '__proto__' (JSON.parse can produce one);
     sorting keeps serialization deterministic. */
  function ownKeys(node) {
    var keys = Object.keys(node);
    if (Object.prototype.hasOwnProperty.call(node, '__proto__') && keys.indexOf('__proto__') < 0) {
      keys.push('__proto__');
    }
    return keys.sort();
  }

  /* Deep copy of a non-schema value. Object.create(null) so an own '__proto__'
     key is stored as data instead of hitting the prototype setter. */
  function copyVerbatim(node) {
    if (node === null || typeof node !== 'object') { return node; }
    if (Array.isArray(node)) {
      var list = [];
      for (var i = 0; i < node.length; i++) { list.push(copyVerbatim(node[i])); }
      return list;
    }
    var out = Object.create(null);
    var keys = ownKeys(node);
    for (var k = 0; k < keys.length; k++) { out[keys[k]] = copyVerbatim(node[keys[k]]); }
    return out;
  }

  /* Map of subschemas (properties, $defs, ...): map keys are property names,
     not keywords, so they are kept verbatim even when named 'title'/'default'. */
  function shrinkSchemaMap(map, stage, depth) {
    if (map === null || typeof map !== 'object' || Array.isArray(map)) { return copyVerbatim(map); }
    if (depth >= SCHEMA_MAX_DEPTH) { return copyVerbatim(map); }
    var out = Object.create(null);
    var keys = ownKeys(map);
    for (var k = 0; k < keys.length; k++) { out[keys[k]] = shrinkSchema(map[keys[k]], stage, depth + 1); }
    return out;
  }

  /**
   * Recursive documentation trim, context-aware: annotation keys are dropped only
   * on objects in schema position. The result validates identically to the input;
   * only non-semantic keys are dropped, in stages controlled by `stage`
   * (0 = keep everything, 1 = drop doc keys, 2 = also drop description/default).
   * Keys are emitted in sorted order so identical schemas serialize to identical bytes.
   * Boolean subschemas pass through unchanged.
   */
  function shrinkSchema(node, stage, depth) {
    if (node === null || typeof node !== 'object') { return node; }
    if (depth >= SCHEMA_MAX_DEPTH) { return copyVerbatim(node); } // keep the subtree as-is rather than corrupting it
    if (Array.isArray(node)) {
      var list = [];
      for (var i = 0; i < node.length; i++) { list.push(shrinkSchema(node[i], stage, depth + 1)); }
      return list;
    }
    var out = Object.create(null);
    var keys = ownKeys(node);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var hasDoc = Object.prototype.hasOwnProperty.call(SCHEMA_DOC_KEYS, key);
      var hasAnn = Object.prototype.hasOwnProperty.call(SCHEMA_ANNOTATION_KEYS, key);
      if (stage >= 1 && hasDoc) { continue; }
      if (stage >= 2 && hasAnn) { continue; }
      var value = node[key];
      if (Object.prototype.hasOwnProperty.call(SCHEMA_MAP_KEYS, key)) {
        out[key] = shrinkSchemaMap(value, stage, depth + 1);
      } else if (key === 'items' && Array.isArray(value)) {
        var tuple = [];
        for (var t = 0; t < value.length; t++) { tuple.push(shrinkSchema(value[t], stage, depth + 1)); }
        out[key] = tuple;
      } else if (Object.prototype.hasOwnProperty.call(SCHEMA_CHILD_KEYS, key) || key === 'items') {
        out[key] = shrinkSchema(value, stage, depth + 1);
      } else if (Object.prototype.hasOwnProperty.call(SCHEMA_ARRAY_KEYS, key) && Array.isArray(value)) {
        var schemas = [];
        for (var a = 0; a < value.length; a++) { schemas.push(shrinkSchema(value[a], stage, depth + 1)); }
        out[key] = schemas;
      } else {
        out[key] = copyVerbatim(value);
      }
    }
    return out;
  }

  function parseable(json) {
    if (!json) { return false; }
    try { JSON.parse(json); return true; } catch (e) { return false; }
  }

  /**
   * Tool schema as a JSON string. The schema is ALWAYS sent in full -
   * no documentation stripping stages and no size budget. shrinkSchema at stage 0 only
   * normalizes key order (deterministic bytes) and deep-copies data positions, preserving
   * description/default/examples/custom keys and an own '__proto__' verbatim.
   * Invalid or non-serializable schemas raise a meaningful error instead of
   * silently degrading to a permissive stub; an absent schema legitimately
   * defaults to an empty object schema.
   */
  function schemaString(schema) {
    if (schema === undefined || schema === null) {
      schema = { type: 'object', properties: {} };
    }
    if (typeof schema !== 'object' || Array.isArray(schema)) {
      throw new Error('schemaString: tool schema must be an object, got ' + (Array.isArray(schema) ? 'array' : typeof schema));
    }
    var candidate;
    try {
      candidate = shrinkSchema(schema, 0, 0);
    } catch (e) {
      throw new Error('schemaString: schema is not shrinkable: ' + (e && e.message ? e.message : e));
    }
    var json;
    try {
      json = JSON.stringify(candidate);
    } catch (e) {
      throw new Error('schemaString: schema is not serializable: ' + (e && e.message ? e.message : e));
    }
    if (!json || !parseable(json)) {
      throw new Error('schemaString: schema produced empty or unparseable JSON');
    }
    return json;
  }

  function compactSchemaBudget(schema) { return schemaString(schema); }

  /** legacy entry point (kept for callers that relied on the global budget) */
  function compactSchema(schema) { return schemaString(schema); }

  function retargetResultText(text, full, limit) {
    var cap = limit === undefined ? TOOL_RESULT_LIMIT : limit;
    if (!cap) { return String(text || ''); }
    var out = compactText(text, full ? cap : Math.max(2000, Math.round(cap / 4)));
    if (out.length < String(text || '').length) {
      logLine('tool result truncated: ' + String(text || '').length + ' -> ' + out.length + ' chars (toolResultLimit=' + cap + ')');
    }
    return out;
  }

  function stallTimeoutMs() { return budget('stallTimeoutMs', STALL_TIMEOUT_MS); }
  function stallWarnMs() { return Math.min(STALL_WARN_MS, Math.max(5000, stallTimeoutMs() / 4)); }

  function generationOptions(outputTokens) {
    return Buffer.concat([
      varintField(1, 1),
      varintField(2, outputTokens || MAX_OUTPUT_TOKENS),
      varintField(3, 400),
      doubleField(5, 1.0),
      varintField(7, 40),
      doubleField(8, 0.99),
    ]);
  }

  /** Stable per-message id keeps the request prefix identical across turns (server-side caching). */
  function uuidFromHash(material) {
    var h = crypto.createHash('sha1').update(material).digest('hex');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
  }

  function stableMessageId(role, text, calls, results, images, index, toolCallId) {
    /* index deliberately excluded: a wire id keyed on position re-labels every message after any
       mid-history insertion (context/note/tool approval), silently killing the server prefix
       match at that depth - which is exactly the 'cache break' the log kept reporting */
    var material = String(role) + '|' + (toolCallId || '') + '|' + String(text || '');
    var i;
    for (i = 0; i < (calls || []).length; i++) { material += '|call:' + (calls[i].id || '') + ':' + (calls[i].name || '') + ':' + normalizeArgs(calls[i].arguments); }
    for (i = 0; i < (results || []).length; i++) { material += '|res:' + (results[i].id || '') + ':' + results[i].content; }
    for (i = 0; i < (images || []).length; i++) {
      material += '|img:' + (images[i].mime || '') + ':' + crypto.createHash('sha1').update(String(images[i].data || '')).digest('hex');
    }
    return uuidFromHash(material);
  }

  var lastPayloadStats = null;
  var payloadEchoMode = null;

  /** Where the request size actually goes, in the shape the CLI reports. */
  function describePayload(s) {
    var pct = function (part) { return s.total ? Math.round((part / s.total) * 100) : 0; };
    return 'payload break-down: system=' + s.system + 'B(' + pct(s.system) + '%, ' + s.systemChars + ' chars) ' +
      'messages=' + s.messages + 'B(' + pct(s.messages) + '%, ' + s.messageCount + ' msgs)' +
      (s.textBytes ? (' [text=' + s.textBytes + 'B results=' + s.resultBytes + 'B calls=' + s.callBytes + 'B]') : '') +
      (s.reasoningBytes ? (' reasoning=' + s.reasoningBytes + 'B(' + s.reasoningMsgs + '/' + s.assistantMsgs + ' turns, ' + s.echoMode + ')') : '') +
      (s.imageBytes ? (' images=' + s.imageBytes + 'B(' + s.imageCount + ')') : '') +
      ' tools=' + s.tools + 'B(' + pct(s.tools) + '%, ' + s.toolCount + ' tools) ' +
      'metadata=' + s.metadata + 'B' +
      ' | hash body=' + s.bodyHash + ' sys=' + s.systemHash + ' msg0=' + s.firstMsgHash + ' tools=' + s.toolsHash;
  }

  function buildChatRequest(token, model, systemPrompt, messages, tools, sessionId, convIds) {
    var metadataField = lenField(1, buildMetadata(token));
    var systemField = strField(2, systemPrompt || 'You are a helpful assistant.');
    var parts = [metadataField, systemField];
    var msgIdsSeen = new Map();
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var source = m.role === 'assistant' ? 2 : (m.role === 'tool' ? 4 : 1);
      /* content-keyed wire id + occurrence dedup: identical messages still get unique ids, but
         inserting a message mid-history no longer shifts every following id */
      var baseMsgId = stableMessageId(m.role, m.text || '', m.toolCalls, m.toolResults, m.images, 0, m.toolCallId || '');
      var dup = msgIdsSeen.get(baseMsgId) || 0;
      msgIdsSeen.set(baseMsgId, dup + 1);
      var msgParts = [
        strField(1, dup ? uuidFromHash(baseMsgId + '|dup:' + dup) : baseMsgId),
        varintField(2, source),
      ];
      if (m.text) { msgParts.push(strField(3, m.text)); }
      var images = m.images || [];
      for (var k = 0; k < images.length; k++) {
        msgParts.push(lenField(10, Buffer.concat([
          strField(1, images[k].data),
          strField(2, images[k].mime || 'image/png'),
        ])));
      }
      var calls = m.toolCalls || [];
      for (k = 0; k < calls.length; k++) {
        msgParts.push(lenField(6, Buffer.concat([
          strField(1, calls[k].id),
          strField(2, calls[k].name),
          strField(3, calls[k].arguments || '{}'),
        ])));
      }
      if (m.role === 'tool') {
        if (m.toolCallId) { msgParts.push(strField(7, m.toolCallId)); }
        if (m.isError) { msgParts.push(varintField(9, 1)); }
      }
      if (m.meta) {
        var nonEmptyStr = function (v) { return typeof v === 'string' && v.length > 0; };
        /* thinking_redacted (#13): the server redacted this turn's chain-of-thought, so the
           plaintext #11 stays off the wire - the redaction flag, sealed signature and ids
           still echo so the turn replays byte-identically to a native client's */
        if (m.meta.thinkingRedacted === true) { msgParts.push(varintField(13, 1)); }
        if (!m.meta.thinkingRedacted && nonEmptyStr(m.meta.thinking)) { msgParts.push(strField(11, m.meta.thinking)); }
        if (nonEmptyStr(m.meta.signature)) { msgParts.push(strField(12, m.meta.signature)); }
        if (nonEmptyStr(m.meta.signatureType)) { msgParts.push(strField(18, m.meta.signatureType)); }
        /* gemini_thought_signature (#17) is raw bytes; we carry it base64 in meta */
        if (nonEmptyStr(m.meta.geminiThoughtSignature)) {
          msgParts.push(lenField(17, Buffer.from(m.meta.geminiThoughtSignature, 'base64')));
        }
        /* Desktop echoes the turn ids the server issued back on each assistant message
           (ChatMessagePrompt #15/#16/#19) - they join the signed-thinking echo so the stored
           turn is byte-identical to a native client's replay */
        if (nonEmptyStr(m.meta.outputId)) { msgParts.push(strField(15, m.meta.outputId)); }
        if (nonEmptyStr(m.meta.thinkingId)) { msgParts.push(strField(16, m.meta.thinkingId)); }
        if (nonEmptyStr(m.meta.phase)) { msgParts.push(strField(19, m.meta.phase)); }
      }
      parts.push(lenField(3, Buffer.concat(msgParts)));
    }
    parts.push(varintField(7, 5));
    parts.push(lenField(8, generationOptions(model === 'compactor' ? COMPACTION_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS)));
    var toolsAccum = [];
    var toolNames = [];
    var toolFieldBytes = 0;
    var sortedTools = (tools || []).slice().sort(function (a, b) { return String((a && a.name) || '').localeCompare(String((b && b.name) || '')); });
    for (i = 0; i < sortedTools.length; i++) {
      var t = sortedTools[i];
      if (toolNames.indexOf(t.name) >= 0) { continue; }   // duplicate names make the server reject the request
      toolNames.push(t.name);
      var toolSchemaJson = compactSchemaBudget(t.inputSchema);
      if (!parseable(toolSchemaJson)) { toolSchemaJson = SCHEMA_MIN_JSON; }
      var toolDesc = String(t.description || '');
      var toolField = lenField(10, Buffer.concat([
        strField(1, t.name),
        strField(2, toolDesc),
        strField(3, toolSchemaJson),
      ]));
      toolFieldBytes += toolField.length;
      toolsAccum.push(toolField);
      parts.push(toolField);
    }
    /* conversation-scoped ids: the server keys its prompt-cache entries on these. Per-request
       random UUIDs (what the raw CLI does) make every request a new lineage - zero cache hits.
       convIds is a {req, conv} pair resolved per branch by conversationIdsFor - stable within a
       branch's sequential turns, distinct between parallel branches of the same session. */
    var convPair = convIds || { req: uuidFromHash('reqmeta|' + String(sessionId || 'devin-conversation')),
                                conv: uuidFromHash('conv|' + String(sessionId || 'devin-conversation')) };
    parts.push(lenField(15, Buffer.concat([strField(1, convPair.req), varintField(3, 4), varintField(4, 14)])));
    parts.push(strField(16, convPair.conv));
    parts.push(varintField(20, 1));
    parts.push(strField(21, model));
    var body = Buffer.concat(parts);
    var messageBytes = 0;
    var textBytes = 0, resultBytes = 0, callBytes = 0, reasoningBytes = 0, imageBytes = 0, imageCount = 0, reasoningMsgs = 0, assistantMsgs = 0;
    for (i = 0; i < messages.length; i++) {
      var msg = messages[i];
      messageBytes += JSON.stringify(msg).length;
      if (msg.role === 'tool') { resultBytes += String(msg.text || '').length; }
      else { textBytes += String(msg.text || '').length; }
      if (msg.role === 'assistant') {
        assistantMsgs++;
        for (var ci = 0; ci < (msg.toolCalls || []).length; ci++) { callBytes += String(msg.toolCalls[ci].arguments || '').length; }
        if (msg.meta) {
          reasoningMsgs++;
          reasoningBytes += (msg.meta.thinking || '').length + (msg.meta.signature || '').length;
        }
      }
      for (var ii = 0; ii < (msg.images || []).length; ii++) {
        imageCount++;
        imageBytes += String(msg.images[ii].data || '').length;
      }
    }
    var toolBytes = toolFieldBytes;
    var hash8 = function (buf) { return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8); };
    lastPayloadStats = {
      total: body.length,
      metadata: metadataField.length,
      /* segment fingerprints: whichever segment's hash changes between two requests is where
         the server-side prefix match dies */
      bodyHash: hash8(body),
      systemHash: hash8(systemField),
      firstMsgHash: messages.length ? hash8(parts[2]) : '-',
      toolsHash: hash8(Buffer.concat(toolsAccum.length ? toolsAccum : [Buffer.alloc(0)])),
      system: systemField.length,
      systemChars: String(systemPrompt || '').length,
      messages: messageBytes,
      messageCount: messages.length,
      textBytes: textBytes,
      resultBytes: resultBytes,
      callBytes: callBytes,
      reasoningBytes: reasoningBytes,
      reasoningMsgs: reasoningMsgs,
      assistantMsgs: assistantMsgs,
      echoMode: (payloadEchoMode || '-'),
      imageBytes: imageBytes,
      imageCount: imageCount,
      tools: toolBytes,
      toolCount: (tools || []).length,
      model: model,
    };
    return body;
  }

  /* ------------------------------------------------------------------ *
   * credential discovery (CLI OAuth file -> Devin Desktop -> setting)
   * ------------------------------------------------------------------ */

  function devinAppData() {
    return nodePath.join(process.env.APPDATA || nodePath.join(os.homedir(), 'AppData', 'Roaming'), 'Devin');
  }

  function powershell(command) {
    var enc = Buffer.from(command, 'utf16le').toString('base64');
    return cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
      encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function dpapiUnprotect(base64) {
    var script =
      'Add-Type -AssemblyName System.Security;' +
      "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('" + base64 + "'),$null,'CurrentUser'))";
    return powershell(script).trim();
  }

  function scanSqliteBuffer(dbFile, keyName) {
    var buf = fs.readFileSync(dbFile);
    var needle = Buffer.from('secret://{"extensionId":"codeium.windsurf","key":"' + keyName + '"}', 'utf8');
    var from = 0, idx;
    while ((idx = buf.indexOf(needle, from)) !== -1) {
      from = idx + 1;
      var start = idx + needle.length;
      var probe = buf.slice(start, start + 32).toString('latin1');
      if (probe.indexOf('{"type":"Buffer","data":[') !== 0) { continue; }
      var end = buf.indexOf(Buffer.from(']}', 'utf8'), start);
      if (end === -1) { continue; }
      try {
        var obj = JSON.parse(buf.slice(start, end + 2).toString('utf8'));
        if (obj && obj.type === 'Buffer' && Array.isArray(obj.data)) { return Buffer.from(obj.data); }
      } catch (e) { /* keep scanning */ }
    }
    return null;
  }

  function scanSqliteText(dbFile, pattern) {
    var buf = fs.readFileSync(dbFile);
    var m = pattern.exec(buf.toString('latin1'));
    return m ? m[1] : null;
  }

  function desktopCredential() {
    var db = nodePath.join(devinAppData(), 'User', 'globalStorage', 'state.vscdb');
    if (!fs.existsSync(db)) { return null; }
    var blob = scanSqliteBuffer(db, 'windsurf_auth.sessions');
    if (!blob || blob.length < 20 || blob.slice(0, 3).toString('latin1') !== 'v10') { return null; }
    var localState = nodePath.join(devinAppData(), 'Local State');
    if (!fs.existsSync(localState)) { return null; }
    var ls = JSON.parse(fs.readFileSync(localState, 'utf8'));
    var encKey = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
    if (!encKey) { return null; }
    var raw = Buffer.from(encKey, 'base64');
    if (raw.slice(0, 5).toString('latin1') !== 'DPAPI') { return null; }
    var master = Buffer.from(dpapiUnprotect(raw.slice(5).toString('base64')), 'base64');
    var decipher = crypto.createDecipheriv('aes-256-gcm', master, blob.slice(3, 15));
    decipher.setAuthTag(blob.slice(blob.length - 16));
    var plain = Buffer.concat([decipher.update(blob.slice(15, blob.length - 16)), decipher.final()]).toString('utf8');
    var sessions = JSON.parse(plain);
    if (!Array.isArray(sessions) || !sessions.length) { return null; }
    var first = sessions[0] || {};
    var token = first.accessToken || first.apiKey;
    if (!token) { return null; }
    var email = scanSqliteText(db, /"lastLoginEmail":"([^"]+)"/);
    return {
      apiKey: token,
      serverUrl: SERVER_URL_DEFAULT,
      email: email || (first.account && first.account.label) || '',
      accountId: (first.account && first.account.id) || '',
      source: 'devin-desktop',
    };
  }

  function cliCredentialsFile() {
    return nodePath.join(devinAppData(), 'credentials.toml');
  }

  function parseTomlValues(text) {
    var values = {};
    var re = /^([A-Za-z0-9_\-\.]+)\s*=\s*"([^"]*)"/gm;
    var m;
    while ((m = re.exec(text)) !== null) { values[m[1].toLowerCase()] = m[2]; }
    return values;
  }

  function cliCredential() {
    var file = cliCredentialsFile();
    if (!fs.existsSync(file)) { return null; }
    var text = fs.readFileSync(file, 'utf8');
    var values = parseTomlValues(text);
    var order = ['windsurf_api_key', 'session_token', 'access_token', 'token', 'auth_token', 'api_key'];
    var token = null;
    for (var i = 0; i < order.length; i++) { if (values[order[i]]) { token = values[order[i]]; break; } }
    if (!token) {
      var m = /"((?:devin-[a-z-]*token\$)?[A-Za-z0-9_\-\.\$]{32,})"/.exec(text);
      if (m) { token = m[1]; }
    }
    if (!token) { return null; }
    return {
      apiKey: token,
      serverUrl: values.api_server_url || SERVER_URL_DEFAULT,
      email: values.email || '',
      accountId: values.user_id || values.account_id || '',
      source: 'devin-cli-oauth',
    };
  }

  var credCache = { value: null, at: 0 };

  function credentialCandidates(force) {
    if (!force && credCache.value && (Date.now() - credCache.at) < CRED_TTL_MS) { return credCache.value; }
    var list = [];
    function push(cred) {
      if (!cred || !cred.apiKey) { return; }
      for (var i = 0; i < list.length; i++) { if (list[i].apiKey === cred.apiKey) { return; } }
      cred.serverUrl = cred.serverUrl || cfgGet('apiServerUrl', SERVER_URL_DEFAULT);
      list.push(cred);
    }
    var override = cfgGet('apiKey', '');
    if (override) { push({ apiKey: override, serverUrl: cfgGet('apiServerUrl', SERVER_URL_DEFAULT), email: '', accountId: '', source: 'setting' }); }
    try { push(cliCredential()); } catch (e) { logErr('cli credential failed: ' + (e && e.message)); }
    try { push(desktopCredential()); } catch (e) { logErr('desktop credential failed: ' + (e && e.message)); }
    credCache = { value: list, at: Date.now() };
    return list;
  }

  function credentialHint() {
    return 'Devin sign-in not found - run "Devin: Sign in with OAuth (browser)" from the command palette (or "devin auth login"), set "gcmp.devin.apiKey", or sign in to Devin Desktop once.';
  }

  /* ------------------------------------------------------------------ *
   * CLI discovery (used only for the OAuth sign-in command)
   * ------------------------------------------------------------------ */

  var cliCache = null;
  function resolveCliPath(force) {
    if (!force && cliCache && fs.existsSync(cliCache)) { return cliCache; }
    var candidates = [];
    var explicit = cfgGet('cliPath', process.env.GCMP_DEVIN_CLI || '');
    if (explicit) { candidates.push(explicit); }
    var roots = [
      'E:\\Devin', 'D:\\Devin', 'C:\\Devin',
      nodePath.join(process.env.LOCALAPPDATA || '', 'Programs', 'Devin'),
      nodePath.join(process.env.LOCALAPPDATA || '', 'Devin'),
      nodePath.join(process.env.LOCALAPPDATA || '', 'Programs', 'devin'),
    ];
    for (var i = 0; i < roots.length; i++) { candidates.push(nodePath.join.apply(nodePath, [roots[i]].concat(CLI_REL))); }
    for (i = 0; i < candidates.length; i++) {
      try { if (candidates[i] && fs.existsSync(candidates[i])) { cliCache = candidates[i]; return cliCache; } } catch (e) { /* noop */ }
    }
    try {
      var where = cp.execFileSync('where.exe', ['devin.exe'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).split(/\r?\n/)[0].trim();
      if (where && fs.existsSync(where)) { cliCache = where; return cliCache; }
    } catch (e) { /* not on PATH */ }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * chat call
   * ------------------------------------------------------------------ */

  /** Mirrors GCMP's own thinking chain: one stable id, empty part closes the block. */
  function makeThinkingChain(ThinkingPartCtor) {
    var currentId = null;
    return {
      append: function (chunk) {
        if (!ThinkingPartCtor) { return null; }
        if (!currentId) { currentId = 'devin_thinking_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
        return new ThinkingPartCtor(chunk, currentId);
      },
      end: function () {
        if (!ThinkingPartCtor || !currentId) { return null; }
        var part = new ThinkingPartCtor('', currentId);
        currentId = null;
        return part;
      },
      isActive: function () { return currentId !== null; },
    };
  }

  /** tool-call deltas arrive as #6 { #1 id, #2 name, #3 arguments-json }; the first frame
   *  carries id+name, later ones only append argument text. */
  /* Tool-call arguments routinely arrive as invalid strict JSON from the model:
     Windows paths carry lone backslashes ('"E:\VC\x"', '"C:\Users\me"') and string
     values carry raw control characters (a literal newline or tab). The repair pass
     rewrites a payload that failed strict parsing exactly once, deterministically:
     inside a string a backslash that does not open a real escape (\" \\ \/ \b \f
     \n \r \t \uXXXX) becomes \\, and an unescaped control character becomes its JSON
     escape; text outside strings is untouched. A document that already parses
     strictly is never rewritten, a bad '\uXXXX' (e.g. '\Users') is repaired, and a
     payload that still fails afterwards throws the strict error. The #6 structured
     path, the completeness probes and the markup converter all share this one
     repair, so a call cannot pass validation in one layer and fail it in another. */
  function repairToolArgsJson(text) {
    var out = '', inStr = false, esc = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (!inStr) {
        if (ch === '"') { inStr = true; }
        out += ch;
        continue;
      }
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\\') {
        var nx = text.charAt(i + 1);
        var realEscape = '"\\/bfnrt'.indexOf(nx) >= 0 ||
          (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(text.substr(i + 2, 4)));
        if (realEscape) { out += ch; esc = true; }
        else { out += '\\\\'; }                        /* lone backslash -> escaped pair */
        continue;
      }
      var code = text.charCodeAt(i);
      if (code < 0x20) {
        out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t'
          : '\\u' + ('000' + code.toString(16)).slice(-4);
        continue;
      }
      out += ch;
    }
    return out;
  }

  /* strict parse first; on failure exactly one deterministic repair retry. Throws
     the strict error when nothing repairable was found, the repair's own error when
     the repaired text still does not parse. */
  function parseArgsJson(text) {
    try { return JSON.parse(text); }
    catch (e) {
      var repaired = repairToolArgsJson(text);
      if (repaired === text) { throw e; }
      return JSON.parse(repaired);
    }
  }

  /* the shared 'does this args string already form a complete JSON object' probe:
     repair-aware and non-array only - an args string that parses only via the repair
     IS already complete, so a later id-less fragment is orphaned instead of silently
     corrupting it; JSON arrays and scalars never count as complete call arguments */
  function argsObjectOrNull(text) {
    var t = (text === undefined || text === null) ? '' : String(text);
    if (!t.trim()) { return {}; }
    var p = null;
    try { p = parseArgsJson(t); } catch (e) { return null; }
    return (p !== null && typeof p === 'object' && !Array.isArray(p)) ? p : null;
  }

  /** Strict parse with one shared repair retry (repairToolArgsJson above). A #6 frame
   *  whose arguments stay unparseable - truncated, unbalanced, non-object - still
   *  fails the attempt outright rather than emitting fabricated arguments. */
  function parseToolArguments(raw, entry) {
    var text = (raw === undefined || raw === null) ? '' : String(raw);
    var label = '"' + (entry && entry.name ? entry.name : '?') + '" (' + (entry && entry.id ? entry.id : '?') + ')';
    if (!text.trim()) { return {}; }
    var parsed;
    try { parsed = parseArgsJson(text); }
    catch (e) {
      throw new Error('tool call ' + label + ' arguments are not valid JSON (' + text.length + 'B): ' + text.slice(0, 160));
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('tool call ' + label + ' arguments must be a JSON object, got ' + (Array.isArray(parsed) ? 'array' : (parsed === null ? 'null' : typeof parsed)));
    }
    return parsed;
  }

  /** #6 tool-call deltas: emit as soon as the arguments are complete JSON, or at stream end. */
  function emitToolCall(entry, handlers) {
    if (!entry || entry.emitted) { return; }
    if (!entry.name || !String(entry.name).trim()) {
      throw new Error('tool call without a name (' + entry.id + ') - refusing to emit it as a {} call');
    }
    /* normalize arguments through the parser so every emitted call carries canonical JSON -
       malformed payloads throw instead of degrading to a silent '{}' */
    entry.arguments = JSON.stringify(parseToolArguments(entry.arguments, entry));
    if (handlers && handlers.onToolCall) { handlers.onToolCall(entry); }
    entry.emitted = true;                                    // only after validation + handler succeeded
  }

  function noteToolCallParsed(entry) {
    if (entry && !entry.emitted && entry.arguments) {
      /* the same repair-aware object probe the id-less continuation uses: an args
         string that only parses via repairToolArgsJson still counts as complete */
      var complete = argsObjectOrNull(entry.arguments) !== null;
      /* Deliberately NOT reported mid-stream: VS Code starts the next round as soon as a tool call
         arrives, which left the previous request running on the server (two billed, overlapping
         requests per round and the free-tier rate limit tripped). Emitting at stream end keeps one
         request in flight per turn. */
      if (complete && !entry.parsedLogged) {
        entry.parsedLogged = true;
        logLine('tool call arguments parsed ' + entry.name + ' (' + entry.id + ') - reported at stream end');
      }
    }
  }

  function accumulateToolCall(pending, bytes, handlers) {
    var idParts = null, name = null, args = null;
    var fs = parseFields(bytes);
    for (var i = 0; i < fs.length; i++) {
      if (fs[i].bytes === undefined) { continue; }
      if (fs[i].field === 1) { idParts = fs[i].bytes.toString('utf8'); }
      else if (fs[i].field === 2) { name = fs[i].bytes.toString('utf8'); }
      else if (fs[i].field === 3) { args = fs[i].bytes.toString('utf8'); }
    }
    if (idParts) {
      /* id-bearing frame: with a name it opens (or updates) that raw-id entry - the '#'
         suffix convention strips to the stable call id; without a name it is a continuation
         routed strictly to its own raw-id entry, never to 'the last one seen' */
      var rawId = idParts;
      var callId = rawId;
      var hashAt = rawId.indexOf('#');
      if (hashAt > 0) { callId = rawId.slice(0, hashAt); }
      var existing = pending.get(rawId);
      if (name) {
        if (existing) {
          if (existing.name && existing.name !== name) {
            throw new Error('tool call ' + rawId + ' name conflict: "' + existing.name + '" vs "' + name + '"');
          }
          if (!existing.name) {
            existing.name = name;
            if (handlers && handlers.onToolCallStart) { handlers.onToolCallStart(existing.id, name); }
          }
          if (args) { existing.arguments += args; }          // never reset accumulated args
        } else {
          pending.set(rawId, { id: callId, name: name, arguments: args || '' });
          if (handlers && handlers.onToolCallStart) { handlers.onToolCallStart(callId, name); }
        }
        noteToolCallParsed(existing || pending.get(rawId));
      } else {
        if (!existing) {
          if (!args) { return; }                            // truly empty id frame - no-op
          throw new Error('tool delta for unknown id ' + rawId + ' (' + args.length + 'B args) - no pending call owns it');
        }
        if (args) { existing.arguments += args; }
        if (handlers && handlers.onToolCallDelta) { handlers.onToolCallDelta(existing.id, args || ''); }
        noteToolCallParsed(existing);
      }
      return;
    }
    /* id-less continuation: legal only when exactly one INCOMPLETE native (non-markup) call
       is in flight. pending keeps every native call until stream end, so completed previous
       calls are still in the map and must not count - only an entry whose arguments have not
       yet formed a complete JSON object can receive this fragment. Anything else is
       ambiguous or orphaned and fails the attempt explicitly (a silent drop would let a
       partial-args call execute as {}). */
    var activeKeys = [];
    pending.forEach(function (entry, key) {
      if (key.indexOf('markup:') === 0 || entry.emitted) { return; }
      /* repair-aware completeness: an args string that parses only via
         repairToolArgsJson is still a COMPLETE call - a JSON array parses to
         typeof 'object' but is not a complete call-args object, so only a
         non-array object counts */
      var complete = entry.arguments ? argsObjectOrNull(entry.arguments) !== null : false;
      if (!complete) { activeKeys.push(key); }
    });
    if (!args) { return; }                                 // empty id-less frame - a true no-op
    if (activeKeys.length === 0) {
      throw new Error('orphaned arguments fragment (' + args.length + 'B): every pending native call is already complete');
    }
    if (activeKeys.length > 1) {
      throw new Error('id-less continuation with ' + activeKeys.length + ' incomplete pending calls is ambiguous');
    }
    var entry = pending.get(activeKeys[0]);
    entry.arguments += args;
    if (handlers && handlers.onToolCallDelta) { handlers.onToolCallDelta(entry.id, args); }
    noteToolCallParsed(entry);
  }

  /* The model sometimes writes a tool call as literal markup text instead of a structured #6
     delta - '<replace_string_in_file>{...}</replace_string_in_file>' inside a '<root>' wrapper -
     and a client that does not intercept it renders raw XML spam while the intended edit never
     runs. Scan the outgoing text stream for '<toolname>{json}</toolname>' blocks whose name is a
     registered tool: a complete block becomes a real emitted call; a malformed or unclosed one
     is stripped so it can never reach the chat view. Unknown tags pass through untouched. */
  function makeMarkupFilter(toolNameSet, pendingCalls) {
    var buf = '';
    var BUF_MAX = 1048576;                                     // 1 MiB cap on buffered markup
    var rootOpen = false;                                      // consumed '<root>' awaiting '</root>'
    /* markdown code tracking - pseudo-call syntax inside fenced or inline code is sample
       text, not an invocation, so it must pass through literally */
    var codeMode = 'text';                                     // 'text' | 'fence' | 'inline'
    var fenceChar = '', fenceLen = 0, inlineLen = 0;
    var atLineStart = true;                                    // bol flag carried across delta chunks
    var tailCh = '', tailLen = 0;                              // delimiter run held at a chunk edge
    /* Scans emitted text for code-state transitions. A backtick/tilde run that ends exactly
       at the chunk edge is held undecided in tailCh/tailLen because the next delta may
       extend it ('`' + '``' must still open a fence) - 'final' settles a held run when the
       next character is known not to be the same delimiter ('<' boundary) or at stream end.
       Fences open only at line start; '~' runs shorter than a fence are prose (~~strike~~),
       never inline code. */
    function applyCodeRun(ch, run, bol) {
      if (codeMode === 'fence') {
        if (ch === fenceChar && run >= fenceLen) { codeMode = 'text'; fenceChar = ''; fenceLen = 0; }
      } else if (codeMode === 'inline') {
        if (ch === '`' && run === inlineLen) { codeMode = 'text'; inlineLen = 0; }
      } else {
        if (run >= 3 && bol) { codeMode = 'fence'; fenceChar = ch; fenceLen = run; }
        else if (ch === '`') { codeMode = 'inline'; inlineLen = run; }
      }
    }
    function updateCode(s, final) {
      if (tailLen) { s = new Array(tailLen + 1).join(tailCh) + s; tailCh = ''; tailLen = 0; }
      for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (ch === '`' || ch === '~') {
          var run = 1;
          while (i + run < s.length && s.charAt(i + run) === ch) { run++; }
          if (i + run === s.length && !final) { tailCh = ch; tailLen = run; return; }
          applyCodeRun(ch, run, atLineStart);
          i += run - 1;
        }
        atLineStart = (s.charAt(i) === '\n');
      }
    }
    /* index past the balanced '}' starting at s[start] ('{'), or -1 when the buffer ran out
       mid-object. Strings and escapes are skipped so JSON can contain markup safely. */
    function balancedJsonEnd(s, start) {
      var depth = 0, inStr = false, esc = false;
      for (var i = start; i < s.length; i++) {
        var ch = s.charAt(i);
        if (inStr) { if (esc) { esc = false; } else if (ch === '\\') { esc = true; } else if (ch === '"') { inStr = false; } continue; }
        if (ch === '"') { inStr = true; }
        else if (ch === '{') { depth++; }
        else if (ch === '}') { depth--; if (depth === 0) { return i + 1; } }
      }
      return -1;
    }
    function convert(name, jsonText) {
      var parsed = null;
      try { parsed = JSON.parse(jsonText); }
      catch (e) {
        /* models routinely write Windows paths with raw backslashes ('"E:\VC\x"') and
           literal control characters, which is invalid JSON - the shared repair escapes
           them and retries once (bad '\uXXXX' like 'C:\Users' is covered too) */
        try { parsed = JSON.parse(repairToolArgsJson(jsonText)); }
        catch (e2) { parsed = null; }
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logLine('pseudo tool call dropped: <' + name + '> args are not a valid JSON object (' + jsonText.length + 'B)');
        return;
      }
      var uid = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      pendingCalls.set('markup:' + uid, { id: 'markup_' + uid, name: name, arguments: JSON.stringify(parsed) });
      logLine('pseudo tool call converted: <' + name + '> text markup -> real ' + name + ' call (' + jsonText.length + 'B args)');
    }
    /* drain buf into emit text; isEnd flips every 'wait for the next delta' into a final call */
    function drain(isEnd) {
      var emit = '';
      for (;;) {
        var lt = buf.indexOf('<');
        if (lt < 0) { emit += buf; updateCode(buf, isEnd); buf = ''; break; }
        var pre = buf.slice(0, lt);
        emit += pre; updateCode(pre, true);                  // '<' ends any delimiter run
        buf = buf.slice(lt);                                   // buf starts at '<'
        var m = /^<(\/?)([a-z_][a-z0-9_]*)/.exec(buf);
        if (!m) {                                              // '<' not followed by a tag name
          if (!isEnd && /^<\/?$/.test(buf)) { break; }        // tag head may still be arriving
          emit += '<'; buf = buf.slice(1); continue;
        }
        var name = m[2], closing = m[1] === '/';
        var gt = buf.indexOf('>');
        if (gt < 0) {                                          // '<name' with no '>' yet
          if (!isEnd) { break; }
          /* EOF inside code: the fragment is literal sample text even when its name matches
             a registered tool - fenced/inline code never invokes */
          if (codeMode !== 'text') { emit += buf; buf = ''; break; }
          /* EOF: a truncated tag whose name IS a registered tool is stripped (it is broken
             pseudo-call markup, not prose); unknown/ordinary '<' text stays literal */
          if (toolNameSet.has(name)) {
            logLine('pseudo tool call dropped: incomplete <' + (closing ? '/' : '') + name + '> tag at stream end');
            buf = ''; break;
          }
          emit += buf; buf = ''; break;                        // EOF: emit literally
        }
        var tag = buf.slice(0, gt + 1);
        if (codeMode !== 'text') {                             // inside code: markup stays literal
          emit += tag; buf = buf.slice(gt + 1); continue;
        }
        if (closing) {                                         // '</name>'
          if (name === 'root' && rootOpen) { rootOpen = false; buf = buf.slice(gt + 1); continue; }
          emit += tag; buf = buf.slice(gt + 1); continue;      // unknown/stray closer - literal
        }
        /* only the exact attribute-free opening tag '<name>' (whitespace allowed) is
           pseudo-call syntax - '<read file="x">' or '<read/>' is ordinary XML, kept literal */
        if (!/^<[a-z_][a-z0-9_]*\s*>$/.test(tag)) {
          emit += tag; buf = buf.slice(gt + 1); continue;
        }
        if (name === 'root') {
          /* drop the wrapper only when it actually envelopes a pseudo-call; a lone '<root>'
             used as prose stays literal */
          var look = buf.slice(gt + 1);
          /* only a COMPLETE '<toolname>' open tag - exact name, closed by '>' - makes this
             '<root>' a wrapper worth consuming; a partial '<rea' head waits for more input
             instead of committing on a prefix that might finish as a different tag */
          var lm = /^\s*<([a-z_][a-z0-9_]*)\s*>/.exec(look);
          if (lm && toolNameSet.has(lm[1])) { rootOpen = true; buf = look; continue; }
          /* buffer when the lookahead is still undecided: an empty remainder (the delta
             ended exactly at '<root>'), whitespace only, or a partial '<rea' head - the
             next delta may still bring the tool tag that makes this a wrapper */
          if (!lm && !isEnd && /^\s*(<[a-z0-9_]*)?$/.test(look)) { break; }
          emit += tag; buf = look; continue;                            // EOF/prose: '<root>' stays literal
        }
        if (!toolNameSet.has(name)) {                                // '<div>' etc - literal
          emit += tag; buf = buf.slice(gt + 1); continue;
        }
        /* '<toolname>' - optional whitespace, a JSON object, then the matching '</toolname>'.
           All three must be present before anything is consumed or executed. */
        var rest = buf.slice(gt + 1);
        var ws = (rest.match(/^\s*/) || [''])[0].length;
        if (rest.length <= ws) {                               // nothing after the tag yet
          if (!isEnd) { break; }
          logLine('pseudo tool call dropped: bare <' + name + '> at stream end');
          buf = ''; break;                                     // EOF: bare tag - never execute
        }
        if (rest.charAt(ws) !== '{') {                         // '<read> plain text' - not a call
          emit += tag; buf = buf.slice(gt + 1); continue;
        }
        var jEnd = balancedJsonEnd(rest, ws);
        if (jEnd < 0) {                                        // JSON still streaming in
          if (!isEnd) { break; }
          logLine('pseudo tool call dropped: <' + name + '> JSON never closed (' + rest.length + 'B at stream end)');
          buf = ''; break;                                     // EOF: incomplete - never execute
        }
        var closerRe = new RegExp('^</' + name + '\\s*>');
        var after = rest.slice(jEnd);
        var lead = (after.match(/^\s*/) || [''])[0].length;
        var afterWs = after.slice(lead);
        var closeM = closerRe.exec(afterWs);
        if (!closeM) {
          /* closer may still be arriving ('</na' etc) - only wait while what we have is a
             strict prefix of a possible closer; otherwise it is plain text, not a call */
          var minCloser = '</' + name + '>';
          if (!isEnd && afterWs.length < minCloser.length && minCloser.indexOf(afterWs) === 0) { break; }
          if (isEnd && afterWs.length < minCloser.length && minCloser.indexOf(afterWs) === 0) {
            logLine('pseudo tool call dropped: <' + name + '> missing closing tag at stream end');
            buf = ''; break;                                   // EOF: truncated closer - never execute
          }
          emit += tag; buf = rest; continue;                   // no closer ahead - literal text
        }
        convert(name, rest.slice(ws, jEnd));
        buf = afterWs.slice(closeM[0].length);
        /* otherwise whatever follows is plain text - loop handles it */
      }
      return emit;
    }
    return {
      feed: function (chunk) {
        buf += chunk;
        /* drain first - the cap guards unresolved markup still held in buf, not the total
           chunk size, so a large prose delta must not trip it */
        var out = drain(false);
        if (buf.length > BUF_MAX) {
          throw new Error('markup filter buffer exceeded ' + BUF_MAX + 'B - unclosed pseudo tool call markup');
        }
        return out;
      },
      finish: function () { return drain(true); },
    };
  }

  /** #28 = statistics blocks (f32 values keyed by #5: input_tokens / output_tokens / cached_input_tokens) */
  function parseStatsFrame(bytes, usage) {
    /* #28 response_dimension_groups - the same structure the Desktop client renders as the
       "Response Statistics" / "Token Usage" rows under each reply: group {1:title, 2:dimensions},
       dimension {5:uid, 3:metric{1:label,2:value-string}, 4:cumulative_metric{1:label,2:value
       (float32),3:tail,4:plural_tail,5:prefix}, 2:copyable_code{1:label,2:value}}. The token rows
       are authoritative server usage; model/agent_messages ride the metric kinds. */
    var out = usage || {};
    var dimensions = out.dimensionUsage || {};
    var groups = parseFields(bytes);
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].field !== 2 || groups[i].bytes === undefined) { continue; }
      var entries = parseFields(groups[i].bytes);
      var key = null, value = null, textValue = null;
      for (var k = 0; k < entries.length; k++) {
        var f = entries[k];
        if (f.bytes === undefined) { continue; }
        if (f.field === 5) { key = f.bytes.toString('utf8'); }
        else if (f.field === 4) {
          var inner = parseFields(f.bytes);
          for (var m = 0; m < inner.length; m++) {
            if (inner[m].field === 2 && inner[m].bytes && inner[m].bytes.length === 4) {
              value = inner[m].bytes.readFloatLE(0);
            }
          }
        }
        else if (f.field === 3) {
          var metric = parseFields(f.bytes);
          for (var q = 0; q < metric.length; q++) {
            if (metric[q].field === 2 && metric[q].bytes) { textValue = metric[q].bytes.toString('utf8'); }
          }
        }
      }
      if (!key) { continue; }
      if (key === 'agent_messages' && Number.isFinite(value)) { out.agentMessages = Math.round(value); }
      else if (key === 'model' && textValue) { out.modelName = textValue; }
      else if (Number.isFinite(value) && value >= 0) {
        if (key === 'input_tokens') { dimensions.input = value; dimensions.inputPresent = true; }
        else if (key === 'output_tokens') { dimensions.output = value; }
        else if (key === 'cached_input_tokens' || key === 'cache_read_tokens') { dimensions.cachePresent = true; dimensions.cached = value; }
        else if (key === 'cache_write_tokens' || key === 'cache_creation_tokens') { dimensions.cacheWritePresent = true; dimensions.cacheWrite = value; }
        else { continue; }
        out.dimensionUsage = dimensions;
        if (key === 'output_tokens' && !(out.nativeUsage && Number.isFinite(out.nativeUsage.output))) { out.output = value; }
        if (!(out.nativeUsage && out.nativeUsage.inputPresent)) {
          out.input = dimensions.input;
          out.inputPresent = dimensions.inputPresent;
          out.cached = dimensions.cached;
          out.cachePresent = dimensions.cachePresent;
          out.cacheWrite = dimensions.cacheWrite;
          out.cacheWritePresent = dimensions.cacheWritePresent;
          out.output = dimensions.output;
        }
        out.timestampMs = Date.now();
      }
    }
    return out;
  }

  /* #7 usage: ModelUsageStats {2:input_tokens, 3:output_tokens, 4:cache_write_tokens,
     5:cache_read_tokens, 9:model_uid, 10:billing_model_uid, 11:requested_model_uid} - the
     authoritative per-response counters the Desktop client persists as message metrics
     (input_tokens / output_tokens / cache_read_tokens / cache_creation_tokens). Unlike the
     #28 display rows native counters keep their own source: miss/read/write normally stay
     disjoint. Only matching native and display input/write/read counts confirm an included
     write bucket. Confirmed native counters win; display values stay in dimensionUsage. */
  function mergeModelUsageStats(bytes, usage) {
    var out = usage || {};
    out.modelUsageStatsPresent = true;
    var stats = parseFields(bytes);
    var counters = {};
    var inputInFrame = false;
    var positiveCacheInFrame = false;
    var invalidPromptCounter = false;
    for (var i = 0; i < stats.length; i++) {
      var u = stats[i];
      if (u.field === 2) { inputInFrame = true; }
      if ((u.field === 2 || u.field === 4 || u.field === 5) && u.bytes !== undefined) { invalidPromptCounter = true; }
      if (u.bytes === undefined) {
        if (u.field === 2) { counters.input = u.varint; counters.inputPresent = true; counters.inputExplicit = true; }
        else if (u.field === 3) { counters.output = u.varint; }
        else if (u.field === 4) { counters.cacheWritePresent = true; counters.cacheWrite = u.varint; positiveCacheInFrame = positiveCacheInFrame || u.varint > 0; }
        else if (u.field === 5) { counters.cachePresent = true; counters.cached = u.varint; positiveCacheInFrame = positiveCacheInFrame || u.varint > 0; }
        continue;
      }
      if (u.field === 9) { out.statsModelUid = u.bytes.toString('utf8'); }
      else if (u.field === 11) { out.requestedModelUid = u.bytes.toString('utf8'); }
    }
    /* Native ModelUsageStats initializes input_tokens to zero. Apply that default
       only with this frame's numeric cache evidence, not unrelated dimension rows. */
    if (!inputInFrame && positiveCacheInFrame && !invalidPromptCounter) {
      counters.input = 0;
      counters.inputPresent = true;
    }
    if (counters.inputPresent && !invalidPromptCounter) {
      counters.cached = counters.cached || 0;
      counters.cacheWrite = counters.cacheWrite || 0;
      out.nativeUsage = counters;
      out.input = counters.input;
      out.inputPresent = true;
      out.cached = counters.cached;
      out.cachePresent = counters.cachePresent === true;
      out.cacheWrite = counters.cacheWrite;
      out.cacheWritePresent = counters.cacheWritePresent === true;
    }
    if (counters.output !== undefined) {
      out.output = counters.output;
      if (out.nativeUsage) { out.nativeUsage.output = counters.output; }
    }
    out.timestampMs = Date.now();
    return out;
  }

  /* Try an unknown response field as ModelUsageStats: {2:input,3:output,4:cache_write,
     5:cache_read} all f32. If it decodes with plausible token counts, log it - the IDE's
     cache_read_tokens may arrive on a field we have been ignoring. */
  function inspectUsageField(f) {
    try {
      var inner = parseFields(f.bytes);
      var vals = {};
      for (var i = 0; i < inner.length; i++) {
        var g = inner[i];
        if (g.wire === 5 && g.bytes && g.bytes.length === 4) { vals[g.field] = g.bytes.readFloatLE(0); }
        else if (g.wire === 0) { vals[g.field] = g.varint; }
      }
      var plausible = [2, 3, 4, 5].some(function (n) { return Number.isFinite(vals[n]) && vals[n] > 0 && vals[n] < 1e8; });
      if (plausible) {
        logLine('unparsed response field #' + f.field + ' looks like usage stats: ' + JSON.stringify(vals));
      }
    } catch (e) { /* not a nested message */ }
  }

  function postChat(credential, model, systemPrompt, messages, handlers, tools, sessionId, convIds, kind, inputBudget) {
    var host = SERVER_URL_DEFAULT;
    var port = null;
    var path = CHAT_PATH;
    var scheme = 'https';
    try {
      var u = new URL(credential.serverUrl || SERVER_URL_DEFAULT);
      host = u.hostname;
      port = u.port || null;
      scheme = u.protocol === 'http:' ? 'http' : 'https';
      path = u.pathname.replace(/\/$/, '') + CHAT_PATH;
    } catch (e) { /* default host */ }
    var transport = scheme === 'http' ? http : https;

    /* replay any stored compaction for this session+uid: the caller re-sends the ORIGINAL
       transcript after we rebuilt it internally, so the records must restore the effective
       conv before the payload is built (direct postChat callers included). Summary kinds
       never replay: their differently-shaped prompt was already compacted by design, and
       re-applying a record would splice a marker into the summarization source text. */
    if (!isSummaryKind(kind)) {
      var appliedConv = applyConversationCompactions(sessionId, model, { system: systemPrompt, messages: messages });
      systemPrompt = appliedConv.system;
      messages = appliedConv.messages;
    }
    var payload = buildChatRequest(credential.apiKey, model, systemPrompt, messages, tools, sessionId, convIds);
    var body = envelope(payload);
    var cancelled = false;
    var sawFrame = false;
    var contentEmitted = false;
    var attemptNo = 0;
    var trimmedRetry = false;
    /* centralized cancel plumbing: the provider's onCancel is hooked exactly once and keeps
       the SAME fn identity across retries, the compaction rebuild, and the nested compactor
       request - whichever unit is in flight installs itself as activeAttemptCancel, and a
       pending retry delay registers as retryWait so cancellation settles immediately instead
       of waiting for the backoff timer. */
    var activeAttemptCancel = null;
    var retryWait = null;
    var parentCancelHooked = false;
    function fireParentCancel() {
      cancelled = true;
      if (retryWait) {
        var w = retryWait; retryWait = null;
        clearTimeout(w.timer);
        w.reject(cancellationError());
      }
      if (activeAttemptCancel) { try { activeAttemptCancel(); } catch (e) { /* noop */ } }
    }
    function hookParentCancel() {
      if (parentCancelHooked || !handlers || !handlers.onCancel) { return; }
      parentCancelHooked = true;
      handlers.onCancel(fireParentCancel);
    }
    hookParentCancel();
    /* a retry scheduled while the user cancels must reject instead of firing one more request */
    function waitRetry(delay) {
      return new Promise(function (res2, rej2) {
        retryWait = { timer: setTimeout(function () { retryWait = null; res2(); }, delay), reject: rej2 };
      });
    }
    if (cfgGet('dumpRequest', false) === true) {
      try {
        var tmp = os.tmpdir();
        for (var di = 2; di >= 0; di--) {
          var src = nodePath.join(tmp, 'gcmp-devin-last-request' + (di === 0 ? '' : '-' + di) + '.bin');
          var dst = nodePath.join(tmp, 'gcmp-devin-last-request-' + (di + 1) + '.bin');
          if (fs.existsSync(src)) fs.renameSync(src, dst);
        }
        fs.writeFileSync(nodePath.join(tmp, 'gcmp-devin-last-request.bin'), payload);
      } catch (e) { /* diagnostics only */ }
    }

    function attemptChat() {
    var requestStart = Date.now();
    if (cancelled) { return Promise.reject(cancellationError()); }
    if (inputBudget > 0 && handlers && handlers.countPrompt) {
      var currentInput = handlers.countPrompt({ system: systemPrompt, messages: messages });
      if (currentInput > inputBudget) {
        var budgetError = new Error('selected context length exceeds the ' + inputBudget + ' input-token budget (' + currentInput + ' estimated tokens)');
        budgetError.contextBudgetExceeded = true;
        budgetError.retryable = false;
        logLine('selected context budget exceeded: ~' + currentInput + ' / ' + inputBudget + ' input tokens - main upload held for summarization');
        return Promise.reject(budgetError);
      }
    }
    sawFrame = false;
    if (handlers && handlers.onAttemptStart) { handlers.onAttemptStart(attemptNo); }
    return new Promise(function (resolve, reject) {
      var settled2 = false;
      var stallTimer = null;
      var activeReq = null;
      /* settles THIS attempt with a real cancellation error: clears the stall timer, destroys
         the socket, and rejects so the outer promise never hangs waiting for an 'error'/'end'
         event that the cancelled flag would have swallowed. */
      function cancelAttempt() {
        if (settled2) { return; }
        settled2 = true;
        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
        try { if (activeReq) { activeReq.destroy(); } } catch (e) { /* noop */ }
        reject(cancellationError());
      }
      activeAttemptCancel = cancelAttempt;
      /* text lives at executor scope (not inside the res closure) so the stall timer below
         can report how much of the reply had already streamed */
      var text = '';
      var frameCount = 0;
      var lastFrameAt = 0;
      var maxGap = 0;
      var uploadDoneAt = 0;
      var flushedAt = 0;
      var headersAt = 0;
      var req = activeReq = transport.request({
        host: host,
        port: port || undefined,
        path: path,
        method: 'POST',
        agent: scheme === 'http' ? keepAliveAgentHttp : keepAliveAgent,
        headers: {
          'Content-Type': 'application/connect+proto',
          'Connect-Protocol-Version': '1',
          'Authorization': 'Basic ' + credential.apiKey + '-' + credential.apiKey,
          'Accept': '*/*',
          'Accept-Encoding': 'identity',
          'sentry-trace': crypto.randomBytes(16).toString('hex') + '-' + crypto.randomBytes(8).toString('hex') + '-1',
          'Content-Length': body.length,
        },
      }, function (res) {
        /* headers arrived = server accepted and started working; the gap to the first data
           frame is real prefill/queue time, while uploadDone->headers is mostly our upload */
        if (!headersAt) { headersAt = Date.now(); }
        if (res.statusCode !== 200) {
          var chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          /* the error body can stall, abort, or close early too - settle through the same
             cleanup instead of leaving the attempt hanging on an 'end' that never comes */
          res.on('error', function (e) {
            if (settled2) { return; }
            settled2 = true;
            if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
            reject(e);
          });
          res.on('aborted', function () {
            if (settled2 || cancelled) { return; }
            settled2 = true;
            if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
            reject(rpcError(res.statusCode, 'error response aborted mid-body', isRetryableStatus(res.statusCode)));
          });
          res.on('close', function () {
            if (settled2 || cancelled || res.complete) { return; }
            settled2 = true;
            if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
            reject(rpcError(res.statusCode, 'connection closed before the error body completed', isRetryableStatus(res.statusCode)));
          });
          res.on('end', function () {
            if (settled2) { return; }
            settled2 = true;
            if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
            var detail = Buffer.concat(chunks).toString('utf8').slice(0, 400);
            var err = rpcError(res.statusCode, detail, isRetryableStatus(res.statusCode));
            err.headers = res.headers;
            reject(err);
          });
          return;
        }
        var buffer = Buffer.alloc(0);
        text = '';
        var thinkingLen = 0;
        var stopReason = null;
        var usage = { requestedModelUid: model };
        var thinkingSignature = null;
        var signatureType = null;
        var firstFrameAt = 0;
        var pendingCalls = new Map();
        var toolNameSet = new Set();
        for (var tn = 0; tn < (tools || []).length; tn++) { if (tools[tn] && tools[tn].name) { toolNameSet.add(tools[tn].name); } }
        var markupFilter = makeMarkupFilter(toolNameSet, pendingCalls);
        var fieldsSeen = {};
        /* every top-level field number of every data frame - when a stream ends empty
           the only evidence is which fields the server sent (token counters, ids,
           phases, stop), so the failure message names what actually arrived */
        var fieldTally = {};
        var dumpResponse = cfgGet('dumpResponse', false) === true;
        /* frames are always buffered while bounded: a stream that ends empty still
           leaves a raw dump under TEMP even when dumpResponse is off. The cap only
           bounds pathological frame floods; normal replies stop growing far earlier */
        var rawFrames = [];
        var rawBytes = 0;
        var EMPTY_DUMP_CAP = 8 * 1024 * 1024;
        res.on('data', function (chunk) {
          /* a thrown parse/handler error must reject the attempt - an uncaught exception in
             this socket callback would crash the extension host instead */
          try {
          if (cancelled || settled2) { return; }
          sawFrame = true;
          frameCount++;
          var nowAt = Date.now();
          if (lastFrameAt) {
            var gap = nowAt - lastFrameAt;
            if (gap > maxGap) { maxGap = gap; }
            if (gap > stallWarnMs()) {
              logLine('slow stream: ' + gap + 'ms without data (frame ' + frameCount + ', payload=' + body.length + 'B)');
            }
          }
          lastFrameAt = nowAt;
          buffer = Buffer.concat([buffer, chunk]);
          for (;;) {
            if (buffer.length < 5) { break; }
            var flags = buffer.readUInt8(0);
            var ln = buffer.readUInt32BE(1);
            /* envelope guards: only uncompressed-data (0) and end-stream (2) flags exist for
               'identity' encoding, and no legitimate frame approaches 64MiB - a bogus header
               would otherwise park the stream waiting for bytes that never arrive */
            if (flags !== 0 && flags !== 2) {
              throw new Error('unsupported Connect frame flags ' + flags + ' (only data=0 / end=2 are valid for identity encoding)');
            }
            if (ln > 67108864) { throw new Error('Connect frame declares ' + ln + 'B - over the 64MiB limit'); }
            if (buffer.length < 5 + ln) { break; }
            var frame = buffer.slice(5, 5 + ln);
            buffer = buffer.slice(5 + ln);
            if (firstFrameAt === 0) { firstFrameAt = Date.now(); }
            if (flags === 2) {
              var trailerText = frame.toString('utf8');
              /* the end frame is JSON metadata - a body that does not parse is a malformed
                 stream, not a clean end */
              try { JSON.parse(trailerText || '{}'); }
              catch (te) { throw new Error('Devin stream ended with a malformed trailer frame: ' + trailerText.slice(0, 200)); }
              var trailerErr = connectTrailerError(trailerText);
              if (trailerErr) {
                settled2 = true;
                if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
                logErr('stream error: ' + trailerText.slice(0, 500));
                try { req.destroy(); } catch (e2) { /* noop */ }
                reject(trailerErr);
                return;
              }
              continue;
            }
            var fields = parseFields(frame);
            var deltaText = null, deltaThinking = null;
            if (dumpResponse || rawBytes < EMPTY_DUMP_CAP) { rawFrames.push(frame); rawBytes += frame.length; }
            for (var i = 0; i < fields.length; i++) {
              var f = fields[i];
              fieldTally['#' + f.field + (f.bytes === undefined ? ':v' : ':m')] = (fieldTally['#' + f.field + (f.bytes === undefined ? ':v' : ':m')] || 0) + 1;
              if (f.bytes === undefined) {
                /* GetChatMessageResponse varints: #4 delta_tokens (cumulative generated tokens),
                   #14 credit_cost / #18 committed_credit_cost (sint32 -> asIntN(32)), #26
                   committed_quota_cost_basis_points / #27 committed_overage_cost_cents (int64 ->
                   asIntN(64), precision-safe via varintBig), #8 redact / #11 thinking_redacted,
                   #5 stop_reason */
                if (f.field === 5) { stopReason = 'stop:' + f.varint; }
                else if (f.field === 4) { usage.generatedTokens = (usage.generatedTokens || 0) + f.varint; }
                else if (f.field === 14) { usage.creditCost = Number(BigInt.asIntN(32, f.varintBig !== undefined ? f.varintBig : BigInt(f.varint))); }
                else if (f.field === 18) { usage.committedCreditCost = Number(BigInt.asIntN(32, f.varintBig !== undefined ? f.varintBig : BigInt(f.varint))); }
                else if (f.field === 26) { usage.committedQuotaCostBasisPoints = int64Safe(BigInt.asIntN(64, f.varintBig !== undefined ? f.varintBig : BigInt(f.varint))); }
                else if (f.field === 27) { usage.committedOverageCostCents = int64Safe(BigInt.asIntN(64, f.varintBig !== undefined ? f.varintBig : BigInt(f.varint))); }
                else if (f.field === 24) { usage.arenaCapReached = f.varint === 1; }
                else if (f.field === 8) { usage.redacted = f.varint !== 0; }
                else if (f.field === 11) { usage.thinkingRedacted = f.varint !== 0; }
                else { fieldsSeen['#' + f.field + ':v'] = (fieldsSeen['#' + f.field + ':v'] || 0) + 1; }
                continue;
              }
              if (f.field === 3) { deltaText = f.bytes.toString('utf8'); }
              else if (f.field === 9) { deltaThinking = f.bytes.toString('utf8'); }
              else if (f.field === 6) { accumulateToolCall(pendingCalls, f.bytes, handlers); }
              else if (f.field === 28) {
                usage = parseStatsFrame(f.bytes, usage);
                if (handlers && handlers.onUsage) { handlers.onUsage(usage); }
              }
              else if (f.field === 7) {
                usage = mergeModelUsageStats(f.bytes, usage);
                if (handlers && handlers.onUsage) { handlers.onUsage(usage); }
              }
              else if (f.field === 10) { thinkingSignature = (thinkingSignature || '') + f.bytes.toString('utf8'); }   /* delta_signature - chunks append across frames */
              else if (f.field === 21) { signatureType = (signatureType || '') + f.bytes.toString('utf8'); }       /* delta_signature_type - deltas append */
              else if (f.field === 12 && f.bytes.length === 8) { usage.latencySec = f.bytes.readDoubleLE(0); }
              else if (f.field === 23) { usage.actualModelUid = f.bytes.toString('utf8'); }
              else if (f.field === 25) { usage.phase = f.bytes.toString('utf8'); }
              else if (f.field === 17) { usage.serverRequestId = f.bytes.toString('utf8'); }
              else if (f.field === 1) { usage.serverMessageId = f.bytes.toString('utf8'); }
              else if (f.field === 15) { usage.outputId = f.bytes.toString('utf8'); }
              else if (f.field === 16) { usage.thinkingId = f.bytes.toString('utf8'); }
              /* #22 committed_acu_cost stays a double; #18 moved to the varint branch above (int32) */
              else if (f.field === 22 && f.bytes.length === 8) { usage.committedAcuCost = f.bytes.readDoubleLE(0); }
              else if (f.field === 20 && f.bytes.length) { usage.geminiThoughtSignature = f.bytes.toString('base64'); }
              else {
                /* anything else we do not model yet - census it so a new field (a cache_read
                   under a new number, a fresh stats carrier) is visible in the log */
                var tag = '#' + f.field + ':' + f.bytes.length + 'B';
                fieldsSeen[tag] = (fieldsSeen[tag] || 0) + 1;
                if (f.field >= 29) { inspectUsageField(f); }
              }
            }
            /* thinking first when a frame carries both: the reasoning block must stream
               (and close) ahead of the answer text it precedes */
            if (deltaThinking) {
              thinkingLen += deltaThinking.length;
              if (handlers && handlers.onThinking) { handlers.onThinking(deltaThinking); }
            }
            if (deltaText) {
              var emitText = markupFilter.feed(deltaText);
              text += emitText;
              if (emitText) {
                contentEmitted = true;
                if (handlers && handlers.onText) { handlers.onText(emitText); }
              }
            }
          }
          } catch (frameErr) {
            if (settled2 || cancelled) { return; }
            settled2 = true;
            if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
            try { req.destroy(); } catch (e2) { /* noop */ }
            var perr = new Error('Devin stream frame handling failed: ' + ((frameErr && frameErr.message) || frameErr));
            perr.retryable = !contentEmitted;
            reject(perr);
          }
        });
        /* a socket that dies mid-frame ('aborted'/'premature close') is an explicit failure,
           not a silent end - the leftover partial Connect envelope is detected in 'end' too */
        res.on('aborted', function () {
          if (settled2 || cancelled) { return; }
          settled2 = true;
          if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
          dropPooledSockets();
          var abErr = new Error('Devin response aborted mid-stream (' + text.length + ' chars received)');
          abErr.retryable = !contentEmitted;
          reject(abErr);
        });
        res.on('close', function () {
          /* 'close' fires after 'end' on a clean stream (settled2 guards it); with
             res.complete === false it is the premature-close path on runtimes that skip
             'aborted' */
          if (settled2 || cancelled || res.complete) { return; }
          settled2 = true;
          if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
          dropPooledSockets();
          var pcErr = new Error('Devin connection closed before the response completed (' + text.length + ' chars received)');
          pcErr.retryable = !contentEmitted;
          reject(pcErr);
        });
        res.on('end', function () {
          if (cancelled || settled2) { return; }
          /* anything a field handler or emit callback throws must reject here - the default
             would be an uncaught exception inside the socket 'end' listener */
          try {
          settled2 = true;
          if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
          /* leftover bytes at end = a truncated Connect envelope (premature close): fail the
             attempt instead of resolving a reply assembled from a cut-off stream */
          if (buffer.length) {
            dropPooledSockets();
            var truncErr = new Error('Devin stream ended with a truncated Connect frame (' + buffer.length + ' trailing bytes, ' + text.length + ' chars received)');
            truncErr.retryable = !contentEmitted;
            reject(truncErr);
            return;
          }
          var uploadMs = uploadDoneAt ? (uploadDoneAt - requestStart) : -1;
          var serverQueueMs = (firstFrameAt && uploadDoneAt) ? (firstFrameAt - uploadDoneAt) : (firstFrameAt ? (firstFrameAt - requestStart) : -1);
          logLine('timing: payload=' + body.length + 'B upload=' + uploadMs + 'ms flush=' + (flushedAt ? (flushedAt - uploadDoneAt) : -1) +
            'ms headers=' + (headersAt ? (headersAt - requestStart) : -1) + 'ms queue=' + serverQueueMs + 'ms ttfb=' + (firstFrameAt ? (firstFrameAt - requestStart) : -1) +
            'ms total=' + (Date.now() - requestStart) + 'ms stream=' + (firstFrameAt ? (Date.now() - firstFrameAt) : -1) + 'ms gaps=' + frameCount + '/max' + maxGap +
            'ms tools=' + ((tools || []).length) +
            (attemptNo ? (' retry=' + attemptNo) : '') + (lastPayloadStats ? (' | ' + describePayload(lastPayloadStats)) : ''));
          /* Desktop-metrics parity line: the same per-response numbers Devin Desktop persists as
             message metrics (ttft_ms, total_time_ms, input/output/cache_read/cache_creation
             tokens, tpot_ms, tokens_per_sec) plus the model/phase/agent-messages dimensions. */
          var mstats = usage || {};
          var outTok = Number.isFinite(mstats.output) ? mstats.output : 0;
          var totalMsNow = Date.now() - requestStart;
          var tpotMs = outTok > 0 ? Math.round((totalMsNow / outTok) * 10) / 10 : 0;
          var toksPerSec = outTok > 0 ? Math.round((outTok / (totalMsNow / 1000)) * 10) / 10 : 0;
          logLine('stats: ttft_ms=' + (firstFrameAt ? (firstFrameAt - requestStart) : -1) + ' total_time_ms=' + totalMsNow +
            ' input_tokens=' + (Number.isFinite(mstats.input) ? mstats.input : '-') +
            ' output_tokens=' + (outTok || '-') +
            ' cache_read_tokens=' + (Number.isFinite(mstats.cached) ? mstats.cached : '-') +
            ' cache_creation_tokens=' + (Number.isFinite(mstats.cacheWrite) ? mstats.cacheWrite : '-') +
            (tpotMs ? ' tpot_ms=' + tpotMs : '') + (toksPerSec ? ' tokens_per_sec=' + toksPerSec : '') +
            (mstats.modelName ? ' model="' + mstats.modelName + '"' : '') +
            (mstats.phase ? ' phase=' + mstats.phase : '') +
            (mstats.agentMessages ? ' agent_messages=' + mstats.agentMessages : '') +
            (Number.isFinite(mstats.latencySec) && mstats.latencySec ? ' latency_s=' + mstats.latencySec : '') +
            (mstats.actualModelUid ? ' actual_model=' + mstats.actualModelUid : '') +
            (mstats.statsModelUid ? ' stats_model=' + mstats.statsModelUid : '') +
            (Number.isFinite(mstats.creditCost) ? ' credit_cost=' + mstats.creditCost : '') +
            (Number.isFinite(mstats.committedAcuCost) ? ' acu_cost=' + mstats.committedAcuCost : '') +
            (mstats.serverRequestId ? ' req=' + String(mstats.serverRequestId).slice(0, 8) : ''));
          var seenKeys = Object.keys(fieldsSeen);
          if (seenKeys.length) { logLine('response fields census: ' + seenKeys.join(' ')); }
          /* dumps the buffered Connect frame bodies in the same 5-byte-header format
             the request dump uses - returns the path so failures can name it */
          function writeResponseDump() {
            if (!rawFrames.length) { return null; }
            try {
              var outParts = [];
              for (var rf = 0; rf < rawFrames.length; rf++) {
                var hdr = Buffer.alloc(5);
                hdr.writeUInt8(0, 0); hdr.writeUInt32BE(rawFrames[rf].length, 1);
                outParts.push(hdr, rawFrames[rf]);
              }
              var dumpPath = nodePath.join(os.tmpdir(), 'gcmp-devin-last-response.bin');
              fs.writeFileSync(dumpPath, Buffer.concat(outParts));
              return dumpPath;
            } catch (e) { return null; /* diagnostics only */ }
          }
          if (dumpResponse) { writeResponseDump(); }
          var tailText = markupFilter.finish();
          /* mark BEFORE the callback: a throwing onText must leave the attempt flagged
             non-retryable, or the replay would re-emit this tail */
          if (tailText) { text += tailText; contentEmitted = true; if (handlers && handlers.onText) { handlers.onText(tailText); } }
          /* markup pseudo-calls duplicate the equivalent native #6 call when the model wrote
             both: same name + same canonical args means the native one wins (once). Multiple
             intentional native calls with identical args are NOT collapsed - each keeps its
             own id and its own slot in the emitted list. */
          var nativeCanon = {};
          /* membership is decided by the pending-map KEY prefix ('markup:') - a native call
             id that merely starts 'markup_' must not classify itself as pseudo-markup. Args
             canonicalize via normalizeArgs so unsorted key order cannot defeat the dedup. */
          pendingCalls.forEach(function (entry, key) {
            if (String(key).indexOf('markup:') === 0) { return; }
            try { nativeCanon[entry.name + '|' + normalizeArgs(entry.arguments || '{}')] = true; } catch (e) { /* malformed - the pass below reports it */ }
          });
          var markupDrop = [];
          pendingCalls.forEach(function (entry, key) {
            if (String(key).indexOf('markup:') !== 0) { return; }
            var canon = null;
            try { canon = entry.name + '|' + normalizeArgs(entry.arguments || '{}'); } catch (e) { /* malformed - reported below */ }
            if (canon && nativeCanon[canon]) {
              markupDrop.push(key);
              logLine('pseudo tool call skipped: <' + entry.name + '> duplicates the native ' + entry.name + ' call already in the stream');
            }
          });
          for (var md = 0; md < markupDrop.length; md++) { pendingCalls.delete(markupDrop[md]); }
          /* validate BEFORE anything is emitted: a call naming a tool outside the request's
             tool set, or one whose arguments never parse to an object, rejects the whole
             attempt - the provider must never see a half-emitted batch or a {} / {raw}
             stand-in for broken arguments. Arguments are normalized to canonical JSON here
             so every emitted entry is already validated. */
          var calls = [];
          var malformed = null;
          pendingCalls.forEach(function (entry) {
            if (malformed) { return; }
            if (!entry.name) { malformed = 'a tool call without a name (' + entry.id + ')'; return; }
            if (!toolNameSet.has(entry.name)) { malformed = 'a call to unknown tool "' + entry.name + '" (not in the request tool set)'; return; }
            var parsed = null;
            /* the same parse+repair as emitToolCall/parseToolArguments - validation and
               emission can never disagree about whether the arguments are legal */
            try { parsed = entry.arguments ? parseArgsJson(entry.arguments) : {}; }
            catch (e) { malformed = 'malformed arguments for ' + entry.name + ' (' + entry.id + '): ' + ((e && e.message) || e); return; }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { malformed = 'non-object arguments for ' + entry.name + ' (' + entry.id + ')'; return; }
            entry.arguments = JSON.stringify(parsed);
            calls.push(entry);
          });
          if (malformed) {
            logErr('tool call rejected: Devin emitted ' + malformed + ' - failing the attempt before any call was reported');
            var toolErr = new Error('Devin emitted ' + malformed);
            toolErr.retryable = !contentEmitted;
            reject(toolErr);
            return;
          }
          calls.forEach(function (entry) { contentEmitted = true; emitToolCall(entry, handlers); });
          /* any stream that produced neither text nor an invocable tool call is an empty reply
             - including one that carried only reasoning. A thinking-only success left a blank
             assistant message (reasoning was reported, the visible answer never arrived), so
             it retries like a real empty stream; onAttemptStart resets the reasoning echo.
             A summary kind is stricter: whitespace-only text emits nothing meaningful and a
             whitespace 'summary' must surface as an honest error, not a completed summary. */
          var emptyReply = isSummaryKind(kind) ? (!String(text).trim() && !calls.length) : (!text && !calls.length);
          if (emptyReply) {
            var tallyText = Object.keys(fieldTally).sort().map(function (k) { return k + 'x' + fieldTally[k]; }).join(' ');
            var emptyDump = writeResponseDump();
            logErr('empty stream: no visible text or tool calls in ' + frameCount + ' frames (payload=' + body.length + 'B, stop=' + stopReason + (thinkingLen ? ', thinking=' + thinkingLen + ' chars' : '') + (tallyText ? ', fields: ' + tallyText : '') + (emptyDump ? ', dump=' + emptyDump : '') + ')');
            /* the thrown error carries the same evidence: the UI reason names exactly
               which fields arrived and where the raw frames landed, so an empty stream
               is diagnosable without the output channel */
            var emptyErr = new Error('Devin returned no content for this request (payload ' + body.length + 'B, frames ' + frameCount +
              ', stop=' + (stopReason || 'none') + ', thinking=' + thinkingLen + 'B' +
              (tallyText ? ', fields: ' + tallyText : '') + (emptyDump ? '; raw stream saved to ' + emptyDump : '') + ')');
            emptyErr.emptyStream = true;
            /* summary whitespace already emitted text upstream - replaying the request
               cannot help, so it fails honestly instead of cycling the compactor */
            emptyErr.retryable = !(isSummaryKind(kind) && text);
            reject(emptyErr);
            return;
          }
          resolve({
            text: text,
            stopReason: stopReason,
            usage: usage,
            toolCalls: calls,
            signature: thinkingSignature,
            signatureType: signatureType,
            timing: { payload: body.length, ttfb: firstFrameAt ? (firstFrameAt - requestStart) : -1, total: Date.now() - requestStart },
          });
          } catch (endErr) {
            if (cancelled) { return; }
            settled2 = true;
            if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
            var eerr = new Error('Devin stream end handling failed: ' + ((endErr && endErr.message) || endErr));
            eerr.retryable = !contentEmitted;
            reject(eerr);
          }
        });
        res.on('error', function (e) { if (!cancelled && !settled2) { settled2 = true; if (stallTimer) { clearInterval(stallTimer); stallTimer = null; } reject(e); } });
      });
      req.setTimeout(CHAT_TTFB_TIMEOUT_MS, function () {
        if (!sawFrame && !settled2) {
          try { req.destroy(Object.assign(new Error('no response within ' + CHAT_TTFB_TIMEOUT_MS + 'ms'), { code: 'ETIMEDOUT' })); } catch (e) { /* noop */ }
        }
      });
      /* after the first byte a silent connection means a dead stream - do not hang the chat forever */
      stallTimer = setInterval(function () {
        if (settled2 || cancelled) { clearInterval(stallTimer); stallTimer = null; return; }
        if (!lastFrameAt) { return; }
        var idle = Date.now() - lastFrameAt;
        var stallLimit = stallTimeoutMs();
        if (!stallLimit) { return; }
        if (idle > stallLimit) {
          logErr('stream stalled: no data for ' + idle + 'ms after ' + frameCount + ' frames (' + text.length + ' chars received)');
          clearInterval(stallTimer);
          settled2 = true;
          dropPooledSockets();
          var stallErr = new Error('Devin stream stalled: no data for ' + Math.round(idle / 1000) + 's (' + text.length + ' chars received)');
          stallErr.retryable = !text;
          try { req.destroy(stallErr); } catch (e2) { /* noop */ }
          reject(stallErr);
        }
      }, 5000);
      req.on('error', function (e) {
        if (!cancelled && !settled2) {
          settled2 = true;
          clearInterval(stallTimer); stallTimer = null;
          if (isRetryableNetwork(e)) { dropPooledSockets(); }
          reject(e);
        }
      });
      /* cancellation is registered once at the postChat level (hookParentCancel) - this attempt
         already published cancelAttempt as activeAttemptCancel, so retries, the compaction
         rebuild, and the nested compactor all share the same stable parent fn. */
      uploadDoneAt = Date.now();
      req.on('finish', function () { flushedAt = Date.now(); });
      if (handlers && handlers.onRequestStart) { handlers.onRequestStart(uploadDoneAt); }
      req.end(body);
    });
    }

    /* Devin's own compaction path (sessions.db): the dropped span is serialized as one user
       message - 'Conversation to summarize:' then '=== MESSAGE i - <Role> ===' blocks - and sent
       to the dedicated 'compactor' uid (the backend's real summarization model, what Desktop
       uses; sessions.db shows generation_model='compactor' producing the structured summary).
       It borrows the parent's #15.1/#16 pair like any side request and sends no tools. */
    function compactSegment(cred, mid, sessId, ids, onCancelReady) {
      /* serialize the dropped span faithfully: call ids and FULL arguments (a summary that
         only knows 'the model called edit_file' loses which file), tool result call ids +
         isError, and image descriptors (mime + count). Image bytes are never inlined into
         this prompt and the descriptor must not claim the pixels were summarized. */
      var prompt = '\nConversation to summarize:\n';
      for (var i = 0; i < mid.length; i++) {
        var m = mid[i];
        var label = m.role === 'assistant' ? 'Assistant' : (m.role === 'tool' ? 'Tool' : (m.role === 'system' ? 'System' : 'User'));
        var text = String(m.text || '');
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
          var callDesc = [];
          for (var c = 0; c < m.toolCalls.length; c++) {
            var tc = m.toolCalls[c] || {};
            callDesc.push('{id:' + (tc.id || '') + ', name:' + (tc.name || '') + ', arguments:' + String(tc.arguments || '{}') + '}');
          }
          text = (text ? text + '\n' : '') + '[tool calls: ' + callDesc.join(', ') + ']';
        }
        if (m.role === 'tool') {
          var meta = [];
          if (m.toolCallId) { meta.push('call_id=' + m.toolCallId); }
          if (m.isError) { meta.push('is_error=true'); }
          if (meta.length) { text = '[' + meta.join(' ') + ']\n' + text; }
        }
        if (m.images && m.images.length) {
          var imgDesc = [];
          for (var im = 0; im < m.images.length; im++) {
            imgDesc.push((m.images[im].mime || 'image/*'));
          }
          text = (text ? text + '\n' : '') + '[' + m.images.length + ' image(s) attached (' + imgDesc.join(', ') + ') - binary not reproduced in this summary input]';
        }
        prompt += '=== MESSAGE ' + i + ' - ' + label + ' ===\n' + text + '\n\n';
      }
      var innerHandlers = { onText: function () {} };
      /* the compactor borrows the parent's cancellation: cancelling the parent settles this
         nested request too instead of leaving it running on the server */
      if (onCancelReady) { innerHandlers.onCancel = function (fn) { onCancelReady(fn); }; }
      /* All families use the dedicated compact continuation backend. */
      return postChat(cred, summaryUidFor(model),
        'Summarize this conversation for continuation in at most ' + COMPACTION_OUTPUT_TOKENS + ' tokens. Preserve the active task, key decisions, file paths, code changes and unresolved results. Omit repeated logs and superseded details.',
        [{ role: 'user', text: prompt }], innerHandlers, [], sessId, ids, 'compaction')
        .then(function (res) {
          var text = res && res.text;
          if (!text || !String(text).trim()) { throw new Error('compactor returned an empty summary'); }
          return text;
        });
    }

    /* Retry only when nothing streamed yet: a replayed stream would duplicate output. */
    function run() {
      return attemptChat().catch(function (err) {
        /* 'prompt is too long' is a hard server rejection before any output. The middle span
           goes to the dedicated 'compactor' uid in Devin's own summarization format and the
           summary is spliced back - the history is compressed, never cut: there is NO elision
           fallback. If the compactor call itself fails the original error propagates with
           context and the history stays untouched. Summarization/compaction requests get the
           honest error directly: a summary built on a trimmed conversation is a wrong summary. */
        var tooLong = err && /prompt is too long|too many tokens|context length|maximum context/i.test(String(err && err.message));
        if (tooLong && !cancelled && !contentEmitted && isSummaryKind(kind)) { throw err; }
        if (tooLong && !trimmedRetry && !cancelled && !contentEmitted && messages.length > 3) {
          trimmedRetry = true;
          /* contiguous split: head = the prefix through the FIRST user message (anything before
             it - a leading context row - stays attached; the old code indexed mid by head.length,
             the count of a one-element array, skipping every message before that user), mid =
             the compacted span, tail = the retained recent suffix. */
          var headEnd = 0;
          for (var hi = 0; hi < messages.length; hi++) {
            if (messages[hi].role === 'user') { headEnd = hi + 1; break; }
          }
          var keepTail = err.contextBudgetExceeded ? 4 : Math.max(4, Math.floor(messages.length * 0.55));
          var tailStart = Math.max(headEnd, messages.length - keepTail);
          var lastUserAt = -1;
          for (var lu = messages.length - 1; lu >= headEnd; lu--) {
            if (messages[lu].role === 'user') { lastUserAt = lu; break; }
          }
          /* a tail that opens on tool results orphans them - pull the boundary BACK to the
             owning assistant message so the whole call/result transaction stays together in
             the retained tail. Pushing the boundary forward could walk it to the end of the
             history and summarize the newest request away. */
          while (tailStart > headEnd && messages[tailStart].role === 'tool') { tailStart--; }
          /* the tail must retain the latest user request - if the split left it inside the
             compacted span (e.g. a trailing tool block follows it), extend the tail back to
             that message so the compacted body never answers a stale prompt */
          if (lastUserAt >= 0 && lastUserAt < tailStart) { tailStart = lastUserAt; }
          var head = messages.slice(0, headEnd);
          var mid = messages.slice(headEnd, tailStart);
          var tail = messages.slice(tailStart);
          if (!mid.length) {
            /* head+tail already cover the whole conversation - no span left to compact, so
               there is no honest way to shrink this prompt: surface the original rejection */
            throw err;
          }
          var compactorCancel = null;
          var origBodyLen = body.length;
          activeAttemptCancel = function () {
            if (compactorCancel) { try { compactorCancel(); } catch (e) { /* noop */ } }
          };
          return compactSegment(credential, mid, sessionId, convIds, function (fn) { compactorCancel = fn; }).then(function (summary) {
            /* the rebuild is a fresh attempt like a retry: bump attemptNo so onAttemptStart
               resets the provider's accumulated reasoning/parts before the new stream */
            attemptNo++;
            var sourceMessages = messages;
            messages = head.concat([{ role: 'user', text: COMPACTION_MARKER + summary }], tail);
            payload = buildChatRequest(credential.apiKey, model, systemPrompt, messages, tools, sessionId, convIds);
            body = envelope(payload);
            /* a summary that did not actually shrink the wire payload would replay the same
               'too long' rejection - fail honestly instead of retrying the identical prompt */
            if (body.length >= origBodyLen) {
              logErr('prompt too long: compacted rebuild is not smaller (' + body.length + 'B vs ' + origBodyLen + 'B) - not retrying');
              throw err;
            }
            /* record the rebuild AFTER the summary proved non-empty and strictly smaller:
               the next turn re-sends the original transcript and must re-apply this
               compaction locally instead of compressing the same span again */
            rememberConversationCompaction(sessionId, model, systemPrompt, sourceMessages, headEnd, tailStart, summary);
            if (handlers && handlers.onCompacted) {
              try { handlers.onCompacted({ system: systemPrompt, messages: messages }); } catch (e) { /* best effort */ }
            }
            logLine('prompt too long: compactor summarized ' + mid.length + ' middle messages into ' +
              String(summary).length + ' chars - retrying with ' + messages.length + '/' + (headEnd + mid.length + tail.length) + ' messages');
            return run();
          }, function (sumErr) {
            if (cancelled) { throw cancellationError(); }
            logErr('prompt too long: compactor failed (' + ((sumErr && sumErr.message) || sumErr) + ') - no fallback, original history preserved');
            var fail = new Error('prompt is too long and the compactor could not summarize ' + mid.length + ' middle messages: ' + ((sumErr && sumErr.message) || sumErr));
            fail.cause = sumErr;
            fail.retryable = false;
            throw fail;
          });
        }
        var retryable = (err && err.retryable !== undefined)
          ? !!err.retryable
          : ((err && err.status !== undefined) ? isRetryableStatus(err.status) : isRetryableNetwork(err));
        var budget = isDnsFailure(err) ? RETRY_LIMIT + 2 : RETRY_LIMIT;
        if (err && err.retryAfterMs) { budget = Math.min(budget, MAX_RATE_LIMIT_RETRIES); }
        /* sawFrame is not the retry gate - a stream that carried only thinking/usage/stop frames
           still produced no user-visible content, so replaying it is safe (and is exactly the
           'empty stream' case that used to die instantly). Content deltas or an emitted tool
           call are what make a replay duplicate output - gate on that instead. */
        if (cancelled) { throw cancellationError(); }
        if (!retryable || attemptNo >= budget || contentEmitted) { throw friendlyNetworkError(err); }
        var delay = (err && err.retryAfterMs) ? err.retryAfterMs : retryDelayMs(err, attemptNo, err.headers);
        attemptNo++;
        logLine('retry chat #' + attemptNo + ' in ' + delay + 'ms (' + (err && err.message) + ')');
        /* cancellable backoff: fireParentCancel rejects this wait, so a cancel during the
           delay settles the outer promise immediately instead of firing one more request */
        return waitRetry(delay).then(run);
      });
    }
    return run();
  }

  /** Finds GCMP's token usage manager (the webview dashboard reads its store). */
  function usageManager() {
    var direct = globalThis.__gcmp_usages;
    if (direct && typeof direct.recordEstimatedTokens === 'function') { return direct; }
    var singletons = globalThis.__gcmp_singletons || {};
    var keys = Object.keys(singletons);
    for (var i = 0; i < keys.length; i++) {
      var candidate = singletons[keys[i]];
      if (candidate && typeof candidate.recordEstimatedTokens === 'function') { return candidate; }
      if (candidate && candidate.usagesManager && typeof candidate.usagesManager.recordEstimatedTokens === 'function') {
        return candidate.usagesManager;
      }
    }
    return null;
  }

  /** Marks the open usage row as failed (the dashboard then shows the error instead of a hanging row). */
  function failUsage(state, uid, startedAt, err) {
    try {
      if (state && prefixOwners.get(state.cacheKey) === state) { prefixOwners.delete(state.cacheKey); }
      var manager = usageManager();
      if (!manager) { return; }
      var requestId = state && state.requestId;
      if (!requestId) {
        if (state && !state.pendingUsage) {
          state.pendingUsage = function (id) {
            try {
              manager.updateActualTokens({
                requestId: id,
                sessionId: state.sessionId,
                otelTraceContext: state.trace,
                rawUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                status: 'failed',
                requestMetricStartTime: startedAt,
                streamStartTime: Date.now(),
                streamEndTime: Date.now(),
              });
              logLine('usage row ' + id + ' marked failed (' + ((err && err.message) || 'error') + ')');
            } catch (e2) { logLine('failed usage update skipped: ' + (e2 && e2.message)); }
          };
        }
        return;
      }
      manager.updateActualTokens({
        requestId: requestId,
        rawUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        status: 'failed',
        requestMetricStartTime: startedAt,
        streamStartTime: Date.now(),
        streamEndTime: Date.now(),
      });
      logLine('usage row ' + requestId + ' marked failed (' + ((err && err.message) || 'error') + ')');
    } catch (e) { logLine('failed usage update skipped: ' + (e && e.message)); }
  }

  /** Closes the row of a stream we retired ourselves (a newer request owns this conversation now). */
  function cancelUsage(state, reason) {
    try {
      if (!state) { return; }
      if (prefixOwners.get(state.cacheKey) === state) { prefixOwners.delete(state.cacheKey); }
      state.closeReason = reason;
      var requestId = state.requestId;
      /* the row id resolves asynchronously - stash a closer so a retire inside the async window
         still flips the row once it opens, instead of leaving it hanging on the dashboard */
      if (!requestId) {
        if (!state.pendingUsage) {
          var manager0 = usageManager();
          if (manager0) {
            state.pendingUsage = function (id) {
              try {
                manager0.updateActualTokens({
                  requestId: id,
                  sessionId: state.sessionId,
                  otelTraceContext: state.trace,
                  rawUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                  status: 'cancelled',
                  requestMetricStartTime: state.startedAt || Date.now(),
                  streamStartTime: state.startedAt || Date.now(),
                  streamEndTime: Date.now(),
                });
                logLine('usage row ' + id + ' closed as cancelled (' + reason + ')');
              } catch (e3) { logLine('cancelled usage update skipped: ' + (e3 && e3.message)); }
            };
          }
          logLine('row close deferred until the row id resolves (' + reason + ')');
        }
        return;
      }
      var manager = usageManager();
      if (!manager) { return; }
      state.pendingUsage = null;
      manager.updateActualTokens({
        requestId: requestId,
        sessionId: state.sessionId,
        otelTraceContext: state.trace,
        rawUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        status: 'cancelled',
        requestMetricStartTime: state.startedAt || Date.now(),
        streamStartTime: state.startedAt || Date.now(),
        streamEndTime: Date.now(),
      });
      logLine('usage row ' + requestId + ' closed as cancelled (' + reason + ')');
    } catch (e) { logLine('cancelled usage update skipped: ' + (e && e.message)); }
  }

  /** Closes a stream's row: cancelUsage stashes a deferred closer when the row id has not resolved yet. */
  function closeUsageNow(state, reason) {
    cancelUsage(state, reason);
  }

  /** Writes the finished token numbers into GCMP's usage store. */
  function recordUsage(state, uid, messages, result, startedAt) {   // uid = concrete Devin model id
    try {
      /* prefix bookkeeping FIRST: it must commit even when the GCMP usage manager (or the row
         id) never materialized, and a delayed pendingUsage callback must not recommit - the
         owner is released before any early return below */
      var norm = normalizeUsage(state, result && result.usage);
      var input = norm.prompt;
      var output = norm.output;
      var cache = norm.cached;
      var actualCache = norm.serverCache ? norm.cached : 0;
      var rawEstimated = state.rawEstimatedInput || state.estimatedInput || 0;
      var ownsPrefix = prefixOwners.get(state.cacheKey) === state;
      if (ownsPrefix && !state.aborted && norm.authoritative && state.kind === 'main-agent' &&
          calibrateTokens(state.cacheKey, uid, rawEstimated, input)) {
        /* feed the same sample into the model-level ratio provideTokenCount reads - without it
           VS Code's compaction gauge stays on the raw chars/4 undercount and lets a subagent
           prompt sail past its context budget instead of summarizing first */
        calibrateTokens('model:' + uid, uid, rawEstimated, input);
        logLine('token calibration: server prompt ' + input + ' vs raw estimate ' + rawEstimated +
          ' -> x' + (Math.round((input / Math.max(1, rawEstimated)) * 100) / 100));
      }
      if (ownsPrefix) {
        /* prefix baselines commit for real turns only: a side channel borrows the main
           branch's lineage AND its prefix anchor (both read-only) - letting a steer or
           summary transcript overwrite a baseline would poison the next turn's estimate
           the same way the old per-kind cache key did */
        if (!state.aborted && norm.authoritative && (!state.kind || state.kind === 'main-agent')) {
          var lineage = (state.kind === 'main-agent' && state.convIds)
            ? { sessionId: state.sessionId, req: state.convIds.req, conv: state.convIds.conv }
            : null;
          rememberPrefixTokens(state.cacheKey, input, norm.observedAt, state.conv, lineage, state.wireTools);
        }
        prefixOwners.delete(state.cacheKey);
      }
      var manager = usageManager();
      var requestId = state.requestId;
      if (!manager) { logLine('usage: GCMP usage manager not reachable'); return; }
      if (state.aborted) { logLine('usage record skipped: request was retired before completion'); return; }
      if (!requestId) {
        if (!state.pendingUsage) {
          state.pendingUsage = function (id) {
            state.requestId = id;
            recordUsage(state, uid, messages, result, startedAt);
          };
        }
        return;
      }
      if (norm.serverCache) {
        logLine('cache split from the server: prompt=' + input + ' (miss ' + norm.input + ' + hit ' + norm.cached + ')');
      } else if (cache) {
        logLine('cached: server reported none, estimated ' + cache + ' tokens (' + Math.round(((state.prefix && state.prefix.fraction) || 0) * 100) +
          '% of the previous ' + ((state.prefix && state.prefix.prevTokens) || 0) + ' input tokens, prompt ' + input + ')');
      } else {
        logLine('cache: server reported the whole prompt (' + input + ' tokens), no split frame');
      }
      var sharedFraction = (state.prefix && state.prefix.fraction) || 0;
      if (norm.serverCache && input > 0 && cache < input * 0.85 && sharedFraction > 0.9) {
        logLine('cache break: the server reused only ' + Math.round((cache / input) * 100) + '% of the prompt although ' +
          Math.round(sharedFraction * 100) + '% of the previous prompt is unchanged - a message inside the history changed shape');
      }
      updatePromptCacheWindow(state, uid, norm);
      if (state.estimatedInput && state.kind === 'main-agent') {
        logLine('prompt estimate check: estimate ' + state.estimatedInput + ' vs server ' + input +
          ' (delta ' + (input - state.estimatedInput) + ')');
      }
      var raw = {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input + output,
      };
      if (norm.serverCache) { raw.prompt_tokens_details = { cached_tokens: actualCache }; }
      var effectiveCache = norm.serverCache ? actualCache : norm.estimatedCache;
      raw.gcmp_devin_cache = { source: norm.cacheSource, estimatedTokens: norm.estimatedCache,
        writeTokens: norm.cacheWrite, expiresAt: (state.prefix && state.prefix.expiresAt) || 0,
        checkedAt: state.cacheCheckedAt || state.startedAt, ttlMs: PROMPT_CACHE_TTL_MS };
      var pricing = pricingFor(uid);
      var meta = catalogMeta(uid);
      /* selected-variant bookkeeping: the actually-billed uid, its Fast Mode
         side (true/false for known native rows, null for SWE or unknown uids),
         and the catalog credit multiplier - advisory only, never a fabricated
         charged-credit figure */
      var nativeEntry = null;
      try { nativeEntry = nativeModels.entryFor(uid); } catch (eN) { nativeEntry = null; }
      var nativeSel = null;
      if (nativeEntry) { try { nativeSel = nativeModels.selection(nativeEntry); } catch (eS) { nativeSel = null; } }
      raw.gcmp_devin_model = {
        uid: uid,
        fastMode: nativeSel ? (nativeSel.fastMode === true) : null,
        creditMultiplier: (meta && Number.isFinite(meta.creditMultiplier)) ? meta.creditMultiplier : null,
      };
      var serverUsage = (result && result.usage) || null;
      var hasCommitted = !!(serverUsage && Object.prototype.hasOwnProperty.call(serverUsage, 'committedCreditCost'));
      var hasReported = !!(serverUsage && Object.prototype.hasOwnProperty.call(serverUsage, 'creditCost'));
      if (hasCommitted || hasReported) {
        /* preserve the server's own figures verbatim - a present 0 is a real
           report; only finite numbers and exact strings (protocol rows that
           type the field as a string) are carried through */
        var creditsRaw = { source: 'server' };
        if (hasCommitted) {
          var committed = serverUsage.committedCreditCost;
          creditsRaw.committed = (Number.isFinite(committed) || typeof committed === 'string') ? committed : null;
        }
        if (hasReported) {
          var reported = serverUsage.creditCost;
          creditsRaw.reported = (Number.isFinite(reported) || typeof reported === 'string') ? reported : null;
        }
        raw.gcmp_devin_credits = creditsRaw;
      }
      var uncached = Math.max(0, input - effectiveCache - norm.cacheWrite);
      var cost = null;
      var costBreakdown = null;
      var costLog = 'n/a';
      if (pricing) {
        var writePrice = pricing.cacheWrite > 0 ? pricing.cacheWrite : pricing.input;
        cost = Math.round(((uncached / 1e6) * pricing.input +
          (effectiveCache / 1e6) * pricing.cacheRead +
          (norm.cacheWrite / 1e6) * writePrice +
          (output / 1e6) * pricing.output) * 1e6) / 1e6;
        costBreakdown = {
          tokens: [input, output, effectiveCache, norm.cacheWrite],
          pricing: [pricing.input, pricing.output, pricing.cacheRead, writePrice],
          cost: [
            Math.round(((uncached / 1e6) * pricing.input) * 1e6) / 1e6,
            Math.round(((output / 1e6) * pricing.output) * 1e6) / 1e6,
            Math.round(((effectiveCache / 1e6) * pricing.cacheRead) * 1e6) / 1e6,
            Math.round(((norm.cacheWrite / 1e6) * writePrice) * 1e6) / 1e6,
          ],
          total: cost,
        };
        costLog = (norm.cacheSource === 'prefix-estimate' ? '~$' : '$') + cost;
        /* the rates actually applied to this row, keyed by the concrete uid that
           ran - a fast/priority pick records the fast rates, never the family
           default's standard label */
        raw.gcmp_devin_pricing = {
          priceUid: uid,
          currency: 'USD',
          unit: 'per 1M tokens',
          input: pricing.input,
          output: pricing.output,
          cacheRead: pricing.cacheRead,
          cacheWrite: pricing.cacheWrite,
        };
        raw.gcmp_devin_cache.estimatedCost = cost;
        raw.gcmp_devin_cache.writePriceAssumed = norm.cacheWrite > 0 && !(pricing.cacheWrite > 0);
      }
      manager.updateActualTokens({
        requestId: requestId,
        sessionId: state.sessionId,
        otelTraceContext: state.trace,
        rawUsage: raw,
        status: 'completed',
        requestMetricStartTime: startedAt,
        streamStartTime: (result && result.timing && result.timing.ttfb >= 0) ? (startedAt + result.timing.ttfb) : startedAt,
        streamEndTime: Date.now(),
        estimatedCost: cost,
        costBreakdown: costBreakdown,
      });
      logLine('cost: ' + costLog + ' (prompt=' + input + ' miss=' + uncached + ' cache=' + actualCache + ' out=' + output +
        (cost && (' | usd ~' + cost)) +
        (meta && meta.creditMultiplier ? (' | model credit x' + meta.creditMultiplier) : '') +
        (meta && meta.maxTokens ? (' | ctx ' + meta.maxTokens) : '') + ')');
      logLine('usage row ' + requestId + ' updated (in=' + input + ' out=' + output + ' cache=' + actualCache + ')');
    } catch (e) { logLine('usage record skipped: ' + (e && e.message)); }
  }

  /** Opens the usage row so the dashboard shows the request while it streams. */
  function beginUsage(state, familyId, uid, messages, requestKind, windowTokens, estimatedPrompt) {
    try {
      var manager = usageManager();
      if (!manager) { logLine('usage: GCMP usage manager not reachable (row not opened)'); return null; }
      var text = messages.map(function (m) { return collectText(m.content); }).join('\n');
      var estimated = Math.max(1, Math.round(estimatedPrompt || calibratedTokens(text.length, state.anchorKey || state.cacheKey, familyId)));
      state.estimatedInput = estimated;
      /* prefix ownership is claimed by the provider BEFORE this call so the baseline commit
         still happens when no usage manager is installed - beginUsage must not install it */
      var previousEstimate = estimateHistory.get(state.cacheKey) || 0;
      var increment = previousEstimate && estimated > previousEstimate ? estimated - previousEstimate : 0;
      estimateHistory.set(state.cacheKey, estimated);
      if (estimateHistory.size > 24) {
        var oldestEstimate = estimateHistory.keys().next();
        if (!oldestEstimate.done) { estimateHistory.delete(oldestEstimate.value); }
      }
      var modelName = familyId.replace('devin-', 'Devin ').replace(/-/g, ' ');
      var ceiling = contextCeiling(uid);
      var pending = manager.recordEstimatedTokens({
        providerKey: 'devin',
        displayName: 'Devin',
        modelId: 'gcmp.devin:::' + familyId,
        modelName: modelName,
        estimatedInputTokens: estimated,
        estimatedIncrement: increment,
        maxInputTokens: windowTokens || ceiling || REPORTED_WINDOW,
        requestKind: requestKind || 'main-agent',
        requestInitiator: 'github.copilot-chat',
        sessionId: state.sessionId,
        otelTraceContext: state.trace,
      });
      if (pending && typeof pending.then === 'function') {
        pending.then(function (id) {
          state.requestId = id;
          if (state.pendingUsage) {
            var closer = state.pendingUsage;
            state.pendingUsage = null;
            closer(id);
            return;
          }
          logLine('usage row ' + id + ' opened (' + modelName + ', ~' + estimated + ' tokens)');
        }, function (e) { logLine('usage row open failed: ' + (e && e.message)); });
      } else if (typeof pending === 'string') {
        state.requestId = pending;
      }
      return pending;
    } catch (e) { logLine('usage pre-record skipped: ' + (e && e.message)); return null; }
  }

  /* ------------------------------------------------------------------ *
   * per-request state
   *
   * VS Code keeps issuing requests while a tool round is still streaming
   * (it starts the next round as soon as a tool call arrives) and it runs
   * the compaction summary in parallel with the agent turn. One shared
   * state object therefore mixed usage rows, session ids and cache
   * accounting between requests. Every request owns its state here, and the
   * newest request of a conversation retires the older stream, so the
   * server never prefills a new turn from a half-generated history.
   * ------------------------------------------------------------------ */

  function newRequestState() {
    return {
      requestId: null, sessionId: null, cacheKey: null, anchorKey: null, metaKey: null, trace: null, prefix: null, cachedEstimate: 0,
      kind: 'main-agent', startedAt: 0, cancel: null, finish: null, finished: false, aborted: false,
      conv: null, familyId: null, branchId: null, estimatedInput: 0, rawEstimatedInput: 0, promptTokens: 0,
      turn: null, pendingUsage: null, closeReason: null, msgCount: 0,
    };
  }

  var liveGenerations = [];   // active streams, newest last

  /* True when the newer request is a successor of the older stream: a follow-up carries strictly more
     messages. An identical resend or a parallel same-id call (subagent) carries the same or fewer
     messages and is not a successor - retiring it is the both-cancelled ping-pong. */
  function sameTurn(older, newer) {
    if (!older || !newer || !older.cacheKey || older.cacheKey !== newer.cacheKey ||
        !older.conv || !newer.conv || !(newer.msgCount > older.msgCount)) { return false; }
    if (older.conv.system !== newer.conv.system || older.conv.messages.length >= newer.conv.messages.length) { return false; }
    for (var i = 0; i < older.conv.messages.length; i++) {
      if (JSON.stringify(older.conv.messages[i]) !== JSON.stringify(newer.conv.messages[i])) { return false; }
    }
    return true;
  }

  /** Retires older streams of the same conversation (same kind only: a summary never kills the agent turn). */
  function retireStaleGenerations(state) {
    var retired = 0;
    for (var i = liveGenerations.length - 1; i >= 0; i--) {
      var other = liveGenerations[i];
      if (other.state === state || other.state.finished || other.state.aborted) { continue; }
      if (other.state.sessionId !== state.sessionId || other.state.kind !== state.kind) { continue; }
      if (!sameTurn(other.state, state)) { continue; }
      other.state.aborted = true;
      retired++;
      logLine('retiring the older ' + other.state.kind + ' stream (row ' + (other.state.requestId || 'pending') +
        ') - a newer request owns this conversation');
      try { if (other.state.cancel) { other.state.cancel(); } } catch (e) { /* noop */ }
      closeUsageNow(other.state, 'superseded by a newer request');
      try { if (other.state.finish) { other.state.finish(); } } catch (e2) { /* noop */ }
    }
    if (retired) { pruneGenerations(); }
    return retired;
  }

  function pruneGenerations() {
    for (var i = liveGenerations.length - 1; i >= 0; i--) {
      if (liveGenerations[i].state.finished) { liveGenerations.splice(i, 1); }
    }
  }

  function trackGeneration(state) {
    liveGenerations.push({ state: state });
    if (liveGenerations.length > 16) { pruneGenerations(); }
  }

  function finishGeneration(state) {
    state.finished = true;
    /* only a retired/cancelled stream releases here: on the success path recordUsage still needs
       the ownership check, and a row id that resolved early used to strip it before recordUsage
       ran - which left prevTokens/expiresAt at 0 and silently disabled every cache estimate */
    if (state.aborted && prefixOwners.get(state.cacheKey) === state) { prefixOwners.delete(state.cacheKey); }
    pruneGenerations();
  }

  /* ------------------------------------------------------------------ *
   * session identity + prompt-cache accounting (the SWE stats frame reports
   * cached_input_tokens as null, so the shared prefix is measured client side)
   * ------------------------------------------------------------------ */

  var prefixCache = new Map();   // conversation key -> { transcript, tokens } of the previous request
  var estimateHistory = new Map();   // conversation key -> last estimated input (for the +delta line)
  var tokenCalibration = new Map();  // conversation / 'model:' + id -> server prompt / our estimate
  var prefixOwners = new Map();   // conversation key -> the request state that owns the shared prefix

  /**
   * 4 chars per token is ~35% under the server's number for this wire format (system prompt, tool
   * schemas, thinking echoes and protobuf framing are not plain text). Scale by the ratio measured
   * against the last authoritative prompt so the dashboard, VS Code's context gauge and the
   * compaction thresholds all agree with what the backend actually bills.
   */
  function calibratedTokens(chars, sessionKey, modelId) {
    var raw = Math.max(1, Math.ceil(chars / 4));
    var k = sessionKey ? (tokenCalibration.get(sessionKey) || 0) : 0;
    if (!(k > 0.5) || k > 2.5) { k = 1; }
    return Math.max(1, Math.round(raw * k));
  }

  function calibrateTokens(sessionKey, modelId, estimated, actual) {
    /* only sizeable, comparable samples: tiny tool rounds and tool-less summarisation payloads have a
       different char/token mix and would drag the factor in the wrong direction */
    if (!estimated || estimated < 2000 || !actual || actual < 2000) { return false; }
    var k = actual / estimated;
    if (!(k > 0.8) || k > 2.0) { return false; }
    var previous = sessionKey ? (tokenCalibration.get(sessionKey) || 0) : 0;
    var smoothed = previous ? (previous * 0.6 + k * 0.4) : k;
    if (sessionKey) { tokenCalibration.set(sessionKey, smoothed); }
    if (tokenCalibration.size > 48) {
      var oldest = tokenCalibration.keys().next();
      if (!oldest.done) { tokenCalibration.delete(oldest.value); }
    }
    return true;
  }

  /** Best estimate of the prompt the server will bill: transcript + tool schemas + wire overhead. */
  function estimatePromptTokens(sessionKey, modelId, system, messages, tools, state) {
    var current = transcriptPartsOf(system, messages);
    var chars = current.chars.length;
    var toolChars = 0;
    var list = tools || [];
    for (var i = 0; i < list.length; i++) {
      var def = list[i] || {};
      /* the actual wire bytes: full description + the exact schemaString(t.inputSchema)
         serialization (absent schemas count their real default object, a stray
         `parameters` key is ignored like the wire ignores it, invalid schemas throw) */
      toolChars += String(def.name || '').length + String(def.description || '').length +
        schemaString(def.inputSchema).length;
    }
    /* When the whole previous turn is still in front of this request, the server's own prompt is the
       exact base: prev prompt + the tokens of what got appended (anchored). The char estimate stays
       the fallback for the first turn of a conversation or after a rewrite. */
    var rawBase = chars + toolChars + 256 + ((messages && messages.length) || 0) * 24;
    if (state) { state.rawEstimatedInput = Math.max(1, Math.ceil(rawBase / 4)); }
    var previous = prefixCache.get(sessionKey);
    /* anchoring on the server's own previous prompt is only valid while the wire tool
       definitions are unchanged: a description/schema drift (or a legacy entry that
       never recorded a fingerprint) falls back to the char estimate. TTL expiry does
       NOT disqualify the anchor - it only kills the HIT estimate elsewhere. */
    var toolsMatch = previous && previous.toolFingerprint === wireToolsFingerprint(tools);
    if (previous && toolsMatch && previous.tokens && previous.parts && previous.parts.length && previous.chars) {
      var sharedParts = 0;
      while (sharedParts < previous.parts.length && sharedParts < current.parts.length &&
             previous.parts[sharedParts].h === current.parts[sharedParts].h) {
        sharedParts++;
      }
      if (sharedParts === previous.parts.length) {
        var addedChars = Math.max(0, chars - previous.chars) + 256;
        return previous.tokens + calibratedTokens(addedChars, sessionKey, modelId);
      }
    }
    return calibratedTokens(rawBase, sessionKey, modelId);
  }

  function cacheKey(sessionId, uid, kind, tools, branchId) {
    var h = crypto.createHash('sha1');
    /* names only: a description or schema drifting mid-session used to orphan the whole prefix
       lineage (and the assistant-meta namespace) although the message history was unchanged */
    var names = (tools || []).map(function (t) { return String((t && t.name) || ''); }).sort();
    var folders = (vscode.workspace.workspaceFolders || []).map(function (folder) { return String(folder.uri); }).sort();
    var material = [uid || '', kind || 'main-agent', folders, names];
    /* a non-root branch gets its own cache row (parallel forks of one session never share a
       prefix baseline); the root lineage keeps the historical 4-field key so previously
       committed entries still match */
    if (branchId) { material.push(String(branchId)); }
    h.update(JSON.stringify(material));
    return String(sessionId || '') + ':' + h.digest('hex').slice(0, 16);
  }

  /* Full wire-definition fingerprint (names stay the cheap accounting key - this is the
     precision layer for prefix anchoring): an exact mirror of the buildChatRequest tool
     loop - the same stable name sort and first-occurrence duplicate-name semantics, but
     keyed on a real Set so '__proto__'/'constructor'/'toString' tool names are genuine
     rows instead of falling into a seen={} prototype trap. Each row carries
     [name, String description, schemaString(t.inputSchema)]: the absent-schema case
     hashes the real default object the wire emits, a stray `parameters` key is treated
     as the absent inputSchema the wire would see, and an invalid schema throws like the
     wire instead of silently fingerprinting a stub the server never saw.
     A description or schema drift must NOT reuse the previous turn's anchored tokens or
     report a client-estimated cache hit against a baseline the server never saw. */
  function wireToolsFingerprint(tools) {
    var sorted = (tools || []).slice().sort(function (a, b) {
      return String((a && a.name) || '').localeCompare(String((b && b.name) || ''));
    });
    var seen = new Set();
    var rows = [];
    for (var i = 0; i < sorted.length; i++) {
      var t = sorted[i] || {};
      var name = String(t.name || '');
      if (seen.has(name)) { continue; }
      seen.add(name);
      rows.push([name, String(t.description || ''), schemaString(t.inputSchema)]);
    }
    return crypto.createHash('sha1').update(JSON.stringify(rows)).digest('hex');
  }

  /** Stable uuid-v4-shaped id per conversation (GCMP renders #serial only for uuid ids). */
  function conversationId(messages) {
    try {
      var seed = '';
      for (var i = 0; i < messages.length; i++) {
        if (roleName(messages[i].role) === 'user') { seed = collectText(messages[i].content); break; }
      }
      if (!seed && messages.length) { seed = collectText(messages[0].content); }
      if (!seed) { return crypto.randomUUID(); }
      var h = crypto.createHash('sha1').update('devin|' + seed).digest('hex');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
    } catch (e) { return crypto.randomUUID(); }
  }

  function isSummaryKind(kind) { return kind === 'summarization' || kind === 'compaction'; }

  /** Ported from GCMP's own classifier ($5/_5) so summarisation/steering show up as such. */
  function classifyRequestKind(messages, tools) {
    try {
      /* plain text only: a tool RESULT rendered into the user message (e.g. a file whose
         code mentions 'Conversation to summarize:') is data, not an instruction - letting
         it satisfy the summary-template check would misroute the whole turn */
      var lastUser = '';
      for (var i = messages.length - 1; i >= 0; i--) {
        if (roleName(messages[i].role) === 'user') { lastUser = collectPlainText(messages[i].content); break; }
      }
      var head = lastUser.replace(/^\s+/, '');
      if (/^\[Terminal\s+\S+\s+notification:/.test(head)) { return 'terminal-steering'; }
      var names = [];
      for (var t = 0; t < (tools || []).length; t++) { names.push(tools[t].name); }
      if (names.length === 1 && names[0] === 'manage_todo_list') { return 'todo-tracker'; }
      if (names.length === 1 && names[0] === 'categorize_prompt') { return 'prompt-categorizer'; }
      if (head.indexOf('The conversation has grown too large for the context window and must be compacted now.') === 0 ||
          head.indexOf('Your task is to create a comprehensive, detailed summary of the entire conversation') === 0 ||
          head.indexOf('Your task is to create a detailed summary of the conversation so far') === 0 ||
          head.indexOf('Conversation to summarize:') === 0) {
        return 'summarization';
      }
    } catch (e) { /* fall through to main-agent */ }
    return 'main-agent';
  }

  function traceContext() {
    return { traceId: crypto.randomBytes(16).toString('hex'), spanId: crypto.randomBytes(8).toString('hex') };
  }

  /** GCMP's own context-usage status bar (exposed by the installer as globalThis.__gcmp_statusbar). */
  function pushContextUsage(modelName, maxInputTokens, inputTokens, requestKind) {
    try {
      var bar = globalThis.__gcmp_statusbar;
      if (bar && typeof bar.updateContextUsage === 'function') {
        bar.updateContextUsage(modelName, maxInputTokens, inputTokens, requestKind, Date.now());
      }
    } catch (e) { /* status bar is best effort */ }
  }

  /* Projection of m.meta onto EXACTLY the fields buildChatRequest emits on the wire:
     #11 thinking only when not thinkingRedacted, non-empty signature/signatureType/
     outputId/thinkingId/phase/geminiThoughtSignature strings, thinkingRedacted only when
     true. Bookkeeping fields (at) and unknown/empty/false values never enter the prefix
     hash - a local field drifting between turns must not break the server prefix match
     although the wire bytes are identical. */
  function wireMetaFingerprint(meta) {
    if (!meta || typeof meta !== 'object') { return null; }
    var s = function (v) { return typeof v === 'string' && v.length > 0; };
    var out = {};
    if (meta.thinkingRedacted !== true && s(meta.thinking)) { out.thinking = meta.thinking; }
    if (s(meta.signature)) { out.signature = meta.signature; }
    if (s(meta.signatureType)) { out.signatureType = meta.signatureType; }
    if (s(meta.outputId)) { out.outputId = meta.outputId; }
    if (s(meta.thinkingId)) { out.thinkingId = meta.thinkingId; }
    if (s(meta.phase)) { out.phase = meta.phase; }
    if (s(meta.geminiThoughtSignature)) { out.geminiThoughtSignature = meta.geminiThoughtSignature; }
    if (meta.thinkingRedacted === true) { out.thinkingRedacted = true; }
    return Object.keys(out).length ? out : null;
  }

  /**
   * Per-message view of the request we send (chars ~ 4 per token): one hash + cumulative char count
   * per message. Hashing each message (instead of keeping the whole transcript) keeps the prefix
   * comparison cheap and lets the state survive a window reload, which is what made the first request
   * after a reload report no cache at all although the server still had the whole prefix.
   */
  function transcriptPartsOf(system, messages) {
    var chunks = [String(system || '')];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i] || {};
      var chunk = (m.role || '') + ':' + (m.text || '') + '|id:' + (m.toolCallId || '') + '|error:' + !!m.isError;
      var calls = m.toolCalls || [];
      for (var c = 0; c < calls.length; c++) { chunk += '|call:' + calls[c].id + ':' + calls[c].name + ':' + normalizeArgs(calls[c].arguments || ''); }
      var results = m.toolResults || [];
      for (var r = 0; r < results.length; r++) { chunk += '|res:' + (results[r].id || '') + ':' + (results[r].content || ''); }
      if (m.meta) {
        var wireMeta = wireMetaFingerprint(m.meta);
        if (wireMeta) { chunk += '|meta:' + JSON.stringify(canonicalJson(wireMeta)); }
      }
      var images = m.images || [];
      for (var g = 0; g < images.length; g++) { chunk += '|img:' + (images[g].mime || '') + ':' + crypto.createHash('sha1').update(String(images[g].data || '')).digest('hex'); }
      chunks.push(chunk);
    }
    var parts = [];
    var cumulative = 0;
    var text = '';
    for (var k = 0; k < chunks.length; k++) {
      cumulative += chunks[k].length + 1;
      parts.push({ h: crypto.createHash('sha1').update(chunks[k]).digest('hex').slice(0, 12), c: cumulative });
      text += (k ? '\n' : '') + chunks[k];
    }
    return { parts: parts, chars: text };
  }

  /* ------------------------------------------------------------------ *
   * internal compaction continuation: when the server rejects a prompt as too
   * long we rebuild the wire history (head + summary + tail), but the caller
   * re-sends the ORIGINAL transcript next turn. Records keyed by session+uid
   * store only the source transcript hashes and boundaries plus the summary
   * text - never the dropped history - so the next request re-applies the
   * compaction locally before lineage/estimates are derived.
   * ------------------------------------------------------------------ */
  var COMPACTION_MARKER = '[earlier history summarized - the prompt exceeded the model context window]\n\n';
  var COMPACTION_RECORD_LIMIT = 48;   // global cap: total records across ALL session keys
  var conversationCompactions = new Map();  // 'session|uid' -> ordered compaction records

  function rememberConversationCompaction(sessionId, uid, system, sourceMessages, headEnd, tailStart, summary) {
    if (!summary || !String(summary).trim()) { return; }
    /* record bounds must be integers strictly inside the source transcript: a malformed
       record is ignored entirely (never silently applied - and never drops the latest
       task, which lives past tailStart by construction) */
    if (!Array.isArray(sourceMessages) || !Number.isInteger(headEnd) || !Number.isInteger(tailStart) ||
        !(headEnd >= 0) || !(headEnd < tailStart) || !(tailStart < sourceMessages.length)) { return; }
    var tp = transcriptPartsOf(system, sourceMessages);
    var hashes = tp.parts.map(function (part) { return part.h; });
    var key = String(sessionId || '') + '|' + String(uid || '');
    var list = conversationCompactions.get(key);
    if (!list) { list = []; }
    list.push({ hashes: hashes, headEnd: headEnd, tailStart: tailStart, summary: String(summary) });
    /* re-insert so the just-written key lands at the Map end (most-recently-used) */
    conversationCompactions.delete(key);
    conversationCompactions.set(key, list);
    /* the cap is 48 records TOTAL across every session|uid key: evict ENTIRE oldest
       lists of other keys first; only once the active key is alone does it trim its
       own oldest records down to the cap */
    var total = 0;
    conversationCompactions.forEach(function (l) { total += l.length; });
    while (total > COMPACTION_RECORD_LIMIT && conversationCompactions.size > 1) {
      /* oldest key that is not the active one - the active key was just re-inserted at
         the end, but when it IS the oldest list the other keys still go first */
      var victimKey = null;
      var kit = conversationCompactions.keys();
      var kstep = kit.next();
      while (!kstep.done) {
        if (kstep.value !== key) { victimKey = kstep.value; break; }
        kstep = kit.next();
      }
      if (victimKey === null) { break; }
      total -= conversationCompactions.get(victimKey).length;
      conversationCompactions.delete(victimKey);
    }
    while (total > COMPACTION_RECORD_LIMIT) { list.shift(); total--; }
  }

  /* Replay every stored compaction whose source prefix still matches the supplied conv, in
     insertion order so a chain of repeated compactions applies end to end. A mismatching or
     parallel branch is left untouched; the caller's arrays are never mutated. */
  function applyConversationCompactions(sessionId, uid, conv) {
    var list = conversationCompactions.get(String(sessionId || '') + '|' + String(uid || ''));
    if (!list || !list.length || !conv || !Array.isArray(conv.messages)) { return conv; }
    var messages = conv.messages;
    for (var ri = 0; ri < list.length; ri++) {
      var rec = list[ri];
      var tp = transcriptPartsOf(conv.system, messages);
      if (tp.parts.length < rec.hashes.length) { continue; }
      var match = true;
      for (var pi = 0; pi < rec.hashes.length; pi++) {
        if (tp.parts[pi].h !== rec.hashes[pi]) { match = false; break; }
      }
      if (!match) { continue; }
      messages = messages.slice(0, rec.headEnd)
        .concat([{ role: 'user', text: COMPACTION_MARKER + rec.summary }])
        .concat(messages.slice(rec.tailStart));
    }
    return (messages === conv.messages) ? conv : { system: conv.system, messages: messages, echo: conv.echo };
  }

  /* Server prompt-cache entries are keyed on the #15.1/#16 conversation ids. They must stay
     constant across a conversation's sequential turns (per-request random UUIDs = every turn
     is a cold miss - measured 0% vs 99.7% in the A/B probe) yet differ between parallel
     branches sharing a head (simultaneous sub-agent waves would otherwise overwrite each
     other's lineage and race server-side). A request whose history fully extends a registered
     branch inherits its ids; anything else forks with ids derived from the deepest divergence
     point - deterministic per branch content and reload-safe. */
  var convBranches = new Map();
  function conversationIdsFor(sessionId, conv, kind) {
    var base = String(sessionId || 'devin-conversation');
    var tp = transcriptPartsOf(conv.system, conv.messages);
    var hashes = [];
    for (var i = 0; i < tp.parts.length; i++) { hashes.push(tp.parts[i].h); }
    var list = convBranches.get(base);
    if (!list) { list = []; convBranches.set(base, list); }
    /* side-channel requests (summarization / terminal steering / trackers) BORROW the lineage
       of the branch they extend instead of advancing its tail: the steering/summary message
       must not become the branch tail, or the next real turn fails to extend it and forks into
       a cold lineage - which is why every steer/summary used to report 0% cache. Borrowing is
       read-only: the main branch's tail stays where the last real turn left it, so the main
       agent and its subagent branches never cross-talk through a shared notification tail. */
    var sideChannel = kind && kind !== 'main-agent';
    var best = null, bestDepth = -1;
    for (var b = 0; b < list.length; b++) {
      var bh = list[b].hashes;
      if (bh.length > hashes.length) { continue; }
      var d = 0;
      while (d < bh.length && bh[d] === hashes[d]) { d++; }
      if (d === bh.length && bh.length > bestDepth) { best = list[b]; bestDepth = bh.length; }
    }
    if (best) {
      if (!sideChannel) { best.hashes = hashes; }
      best.at = Date.now();
      return { req: best.req, conv: best.conv, fork: false };
    }
    if (sideChannel) {
      /* no branch fully extends this request - borrow the deepest partial match (shared head)
         rather than registering a throwaway lineage the server has never cached */
      var deep = null, deepD = -1;
      for (var b3 = 0; b3 < list.length; b3++) {
        var h3 = list[b3].hashes, d3 = 0;
        while (d3 < h3.length && d3 < hashes.length && h3[d3] === hashes[d3]) { d3++; }
        if (d3 > deepD) { deep = list[b3]; deepD = d3; }
      }
      if (deep) { deep.at = Date.now(); return { req: deep.req, conv: deep.conv, fork: false }; }
    }
    var divDepth = 0;
    for (var b2 = 0; b2 < list.length; b2++) {
      var h2 = list[b2].hashes, d2 = 0;
      while (d2 < h2.length && d2 < hashes.length && h2[d2] === hashes[d2]) { d2++; }
      if (d2 > divDepth) { divDepth = d2; }
    }
    var tag = list.length === 0 ? '' : ('|' + divDepth + ':' + (hashes[divDepth] || 'end'));
    var entry = {
      req: uuidFromHash('reqmeta|' + base + tag),
      conv: uuidFromHash('conv|' + base + tag),
      hashes: hashes, at: Date.now(),
    };
    list.push(entry);
    while (list.length > 16) { list.shift(); }
    if (convBranches.size > 64) {
      var oldest = convBranches.keys().next();
      if (!oldest.done) { convBranches.delete(oldest.value); }
    }
    return { req: entry.req, conv: entry.conv, fork: list.length > 1 };
  }

  /** Chars shared with the last COMMITTED prefix of this conversation (0 when nothing
     comparable). READ-ONLY: a request that is still pending (and may be cancelled or fail)
     must never overwrite the confirmed transcript/token baseline - the commit happens in
     rememberPrefixTokens once the server reports its own prompt count. */
  function sharedPrefixWith(sessionKey, system, messages, tools) {
    var current = transcriptPartsOf(system, messages);
    var previous = prefixCache.get(sessionKey);
    if (!previous || !previous.parts || !previous.parts.length) { return { chars: 0, fraction: 0 }; }
    /* real request paths pass the wire tool defs: a fingerprint mismatch (or a legacy
       entry that never recorded one) means there is no comparable baseline - report no
       shared prefix so the client-side cache estimate reads 0. The 3-arg legacy form
       (probes/tests) skips this gate entirely. */
    if (tools !== undefined && previous.toolFingerprint !== wireToolsFingerprint(tools)) { return { chars: 0, fraction: 0 }; }
    var sharedParts = 0;
    while (sharedParts < previous.parts.length && sharedParts < current.parts.length &&
           previous.parts[sharedParts].h === current.parts[sharedParts].h) {
      sharedParts++;
    }
    var previousChars = previous.chars || previous.parts[previous.parts.length - 1].c;
    var shared = sharedParts > 0 ? previous.parts[sharedParts - 1].c : 0;
    if (shared < 400) { return { chars: 0, fraction: 0 }; }
    return { chars: shared, fraction: Math.min(1, shared / Math.max(1, previousChars)), prevTokens: previous.tokens || 0, expiresAt: previous.expiresAt || 0 };
  }

  function prunePrefixCache() {
    var now = Date.now();
    var stale = [];
    prefixCache.forEach(function (value, key) {
      /* an entry past its TTL can never score an estimate - drop those before the size cap so a
         flood of short-lived sub-agent sessions does not evict the live main-agent lineage */
      if (value && value.expiresAt && value.expiresAt <= now) { stale.push(key); }
    });
    for (var s = 0; s < stale.length; s++) { prefixCache.delete(stale[s]); }
    if (prefixCache.size <= 48) { return; }
    var entries = [];
    prefixCache.forEach(function (value, key) { entries.push({ key: key, at: (value && value.at) || 0 }); });
    entries.sort(function (a, b) { return a.at - b.at; });
    while (entries.length > 48) {
      var victim = entries.shift();
      prefixCache.delete(victim.key);
    }
  }

  /** Remember the server's own input token count so the next turn can scale it by the shared
     prefix. With `conv` supplied (and a valid positive authoritative token count) this commits
     a FRESH entry hashed from the actual effective transcript - the wire conv after any
     compaction rebuild - so the baseline can never lag the caller's stale copy. The legacy
     3-argument form still updates an existing entry in place (tests/other callers).
     `lineage` optionally carries the {sessionId, req, conv} wire pair so a forked branch
     survives an extension reload through the persisted state; `tools` (optional 6th arg)
     stamps the committed baseline with the full wire-definition fingerprint so later
       anchoring/cache estimates only trust a matching tool set. */
  function rememberPrefixTokens(sessionKey, tokens, observedAt, conv, lineage, tools) {
    var at = observedAt || Date.now();
    if (conv && conv.messages && Number.isFinite(tokens) && tokens > 0) {
      var tp = transcriptPartsOf(conv.system, conv.messages);
      var entry = { parts: tp.parts, chars: tp.chars.length, tokens: tokens, at: at, expiresAt: at + PROMPT_CACHE_TTL_MS };
      if (tools !== undefined) { entry.toolFingerprint = wireToolsFingerprint(tools); }
      if (lineage && typeof lineage === 'object' &&
          typeof lineage.sessionId === 'string' && lineage.sessionId &&
          typeof lineage.req === 'string' && lineage.req &&
          typeof lineage.conv === 'string' && lineage.conv) {
        entry.lineage = { sessionId: lineage.sessionId, req: lineage.req, conv: lineage.conv };
      }
      prefixCache.set(sessionKey, entry);
      prunePrefixCache();
    } else {
      var existing = prefixCache.get(sessionKey);
      if (existing && Number.isFinite(tokens) && tokens > 0) {
        existing.tokens = tokens;
        existing.at = at;
        existing.expiresAt = at + PROMPT_CACHE_TTL_MS;
      }
    }
    savePrefixState();
  }

  /* ------------------------------------------------------------------ *
   * prefix state across window reloads: the server keeps its prompt cache
   * when VS Code restarts the extension host, so our bookkeeping must too
   * ------------------------------------------------------------------ */

  var prefixStateFile = null;     // set from context.globalStorageUri in install()
  var prefixStateAt = 0;

  function prefixStatePath() {
    if (prefixStateFile) { return prefixStateFile; }
    /* the bundle exports activate behind a getter, so the extension context is usually unavailable:
       find GCMP's own globalStorage (where the usage rows live) instead of trusting the context */
    var roots = [];
    try {
      if (process.env.APPDATA) {
        roots.push(nodePath.join(process.env.APPDATA, 'Code - Insiders', 'User', 'globalStorage', VENDOR));
        roots.push(nodePath.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', VENDOR));
      }
    } catch (e) { /* fall through to temp */ }
    roots.push(nodePath.join(os.tmpdir(), 'gcmp-devin-state'));
    for (var i = 0; i < roots.length; i++) {
      try {
        if (fs.existsSync(nodePath.dirname(roots[i])) || i === roots.length - 1) {
          prefixStateFile = nodePath.join(roots[i], 'devin-prefix-state.json');
          return prefixStateFile;
        }
      } catch (e) { /* next candidate */ }
    }
    return null;
  }

  function loadPrefixState(context) {
    try {
      var uri = context && context.globalStorageUri;
      if (uri && uri.fsPath) { prefixStateFile = nodePath.join(uri.fsPath, 'devin-prefix-state.json'); }
    } catch (e) { /* fall back to the temp path */ }
    var file = prefixStatePath();
    if (!file || !fs.existsSync(file)) { return 0; }
    var state = null;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return 0; }
    if (!state || state.version !== 3) {
      try {
        var quarantine = file + '.legacy.quarantine.' + crypto.randomUUID() + '.json';
        fs.renameSync(file, quarantine);
      } catch (e) { /* stale cache - leave in place */ }
      return 0;
    }
    if (!state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) { return 0; }
    var loaded = 0;
    var cutoff = Date.now() - 72 * 60 * 60 * 1000;
    Object.keys(state.sessions).forEach(function (key) {
      var entry = state.sessions[key];
      if (!entry || !Array.isArray(entry.parts) || !entry.parts.length) { return; }
      if (!Number.isFinite(entry.tokens) || entry.tokens < 0 || !Number.isFinite(entry.chars) || entry.chars < 0) { return; }
      if (!Number.isFinite(entry.at) || entry.at < cutoff || entry.at > Date.now() + 60000) { return; }
      if (entry.parts.some(function (part) { return !part || typeof part.h !== 'string' || !Number.isFinite(part.c) || part.c < 0; })) { return; }
      var expiresAt = Number.isFinite(entry.expiresAt) ? Math.min(entry.expiresAt, entry.at + PROMPT_CACHE_TTL_MS) : 0;
      var restored = { parts: entry.parts, chars: entry.chars || 0, tokens: entry.tokens || 0, at: entry.at, expiresAt: expiresAt };
      if (typeof entry.toolFingerprint === 'string' && entry.toolFingerprint) { restored.toolFingerprint = entry.toolFingerprint; }
      if (entry.lineage && typeof entry.lineage === 'object' &&
          typeof entry.lineage.sessionId === 'string' && entry.lineage.sessionId &&
          typeof entry.lineage.req === 'string' && entry.lineage.req &&
          typeof entry.lineage.conv === 'string' && entry.lineage.conv) {
        restored.lineage = { sessionId: entry.lineage.sessionId, req: entry.lineage.req, conv: entry.lineage.conv };
        /* re-register the persisted branch so a forked conversation keeps its #15.1/#16
           lineage across a reload - the parts hashes are the branch tail the next turn
           extends (or forks past) */
        var branch = convBranches.get(restored.lineage.sessionId);
        if (!branch) { branch = []; convBranches.set(restored.lineage.sessionId, branch); }
        /* same req/conv pair can persist from several keys (main turn + borrowed side
           entries): keep the newest valid record instead of blindly keeping the first */
        var existing = null;
        for (var bi2 = 0; bi2 < branch.length; bi2++) {
          if (branch[bi2].req === restored.lineage.req && branch[bi2].conv === restored.lineage.conv) { existing = branch[bi2]; break; }
        }
        if (!existing) {
          branch.push({ req: restored.lineage.req, conv: restored.lineage.conv,
            hashes: restored.parts.map(function (part) { return part.h; }), at: restored.at });
          while (branch.length > 16) { branch.shift(); }
        } else if (restored.at > (existing.at || 0)) {
          existing.hashes = restored.parts.map(function (part) { return part.h; });
          existing.at = restored.at;
        }
      }
      prefixCache.set(key, restored);
      loaded++;
    });
    prunePrefixCache();
    logLine('prefix state loaded: ' + loaded + ' conversation(s) (' + file + ')');
    return loaded;
  }

  function savePrefixState() {
    var file = prefixStatePath();
    if (!file) { return; }
    var now = Date.now();
    prefixStateAt = now;
    try {
      var sessions = {};
      prefixCache.forEach(function (value, key) {
        if (!value || !value.parts || !value.parts.length) { return; }
        var rec = { parts: value.parts, chars: value.chars || 0, tokens: value.tokens || 0, at: value.at || now, expiresAt: value.expiresAt || 0 };
        if (typeof value.toolFingerprint === 'string' && value.toolFingerprint) { rec.toolFingerprint = value.toolFingerprint; }
        if (value.lineage && typeof value.lineage === 'object' &&
            typeof value.lineage.sessionId === 'string' && value.lineage.sessionId &&
            typeof value.lineage.req === 'string' && value.lineage.req &&
            typeof value.lineage.conv === 'string' && value.lineage.conv) {
          rec.lineage = { sessionId: value.lineage.sessionId, req: value.lineage.req, conv: value.lineage.conv };
        }
        sessions[key] = rec;
      });
      fs.mkdirSync(nodePath.dirname(file), { recursive: true });
      var tmp = file + '.' + process.pid + '.' + now + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 3, sessions: sessions }));
      fs.renameSync(tmp, file);
    } catch (e) { /* state is a cache: never break a request over it */ }
  }

  /**
   * The stats frame has two shapes:
   *   a) split frame  - input_tokens = miss, cached_input_tokens = hit (prompt = miss + hit)
   *   b) plain frame  - input_tokens already covers the whole request (measured against the payload
   *                     size we sent), so the prompt *is* that number and the cached share is unknown
   * The cached share of a plain frame is estimated from the previous *authoritative* prompt times the
   * shared-prefix fraction - never from an estimate, which is what made the number compound turn after
   * turn (571933 -> 651224 -> 731690 ...).
   */
  function normalizeUsage(state, usage) {
    var u = usage || {};
    var count = function (value) { return Number.isFinite(value) ? Math.min(Math.floor(Number.MAX_SAFE_INTEGER / 4), Math.max(0, Math.round(value))) : 0; };
    var miss = count(u.input);
    var output = count(u.output);
    var serverCache = !!u.cachePresent;
    var hit = serverCache ? count(u.cached) : 0;
    var written = u.cacheWritePresent ? count(u.cacheWrite) : 0;
    var nativeCounters = u.nativeUsage && u.nativeUsage.inputPresent;
    var dimensions = u.dimensionUsage;
    if (nativeCounters && dimensions) {
      if (u.nativeUsage.cachePresent !== true && dimensions.cachePresent === true) {
        serverCache = true;
        hit = count(dimensions.cached);
      }
      if (u.nativeUsage.cacheWritePresent !== true && dimensions.cacheWritePresent === true) {
        written = count(dimensions.cacheWrite);
      }
    }
    var displayConfirms = dimensions && dimensions.inputPresent && dimensions.cacheWritePresent &&
      count(dimensions.input) === miss && count(dimensions.cacheWrite) === written && count(dimensions.cached) === hit;
    var nativeWriteIncluded = nativeCounters && u.nativeUsage.inputExplicit && written > 0 && miss >= written &&
      displayConfirms;
    var prompt = miss + hit + ((nativeCounters && !nativeWriteIncluded) || (!nativeCounters && !u.dimensionUsage) ? written : 0);
    var estimatedCache = (serverCache || u.cacheWritePresent || written > 0) ? 0 : cachedTokensFromPrefix(state && state.prefix, prompt, state && (state.cacheCheckedAt || state.startedAt));
    return { prompt: prompt, input: miss, cached: hit, cacheWrite: written, output: output,
      serverCache: serverCache, estimatedCache: estimatedCache,
      authoritative: Number.isFinite(u.input) && u.input >= 0,
      observedAt: u.timestampMs || Date.now(),
      cacheSource: serverCache ? 'server' : (estimatedCache > 0 ? 'prefix-estimate' : 'unknown') };
  }

  /** Cached tokens we expect the server to reuse when it reports nothing. */
  function cachedTokensFromPrefix(prefixInfo, sentPrompt, at) {
    if (!prefixInfo || !prefixInfo.chars || !(prefixInfo.expiresAt > (at || Date.now()))) { return 0; }
    /* base order: the server's own last prompt, then this request's prompt, then the char heuristic
       (the heuristic is what made the cache share swing between 52% and 99% on identical traffic) */
    if (!Number.isFinite(prefixInfo.prevTokens) || !Number.isFinite(sentPrompt) ||
        !Number.isFinite(prefixInfo.fraction) || prefixInfo.prevTokens <= 0 || sentPrompt <= 0) { return 0; }
    return Math.max(0, Math.min(sentPrompt, prefixInfo.prevTokens,
      Math.floor(prefixInfo.prevTokens * Math.min(1, Math.max(0, prefixInfo.fraction)))));
  }

  /* ------------------------------------------------------------------ *
   * assistant meta echo (thinking + sealed signature from the previous turn)
   * ------------------------------------------------------------------ */

  var promptCacheUi = { item: null, timer: null, snapshot: null };

  function updatePromptCacheWindow(state, uid, norm) {
    if (!state || state.kind !== 'main-agent' || state.aborted || (norm && !norm.authoritative)) { return; }
    if (promptCacheUi.snapshot && promptCacheUi.snapshot.startedAt > state.startedAt) { return; }
    promptCacheUi.snapshot = {
      startedAt: state.startedAt, uid: uid, prompt: norm ? norm.prompt : state.promptTokens,
      reusable: norm ? norm.prompt : (state.cachedEstimate || 0),
      expiresAt: norm ? norm.observedAt + PROMPT_CACHE_TTL_MS : ((state.prefix && state.prefix.expiresAt) || 0),
      actualRead: norm && norm.serverCache ? norm.cached : null,
      write: norm ? norm.cacheWrite : 0,
      estimatedRead: norm ? norm.estimatedCache : (state.cachedEstimate || 0)
    };
    renderPromptCacheWindow();
  }

  function renderPromptCacheWindow() {
    var item = promptCacheUi.item;
    var snap = promptCacheUi.snapshot;
    if (!item) { return; }
    if (!snap || vscode.workspace.getConfiguration('gcmp.statusBar').get('devinCache', true) === false) { item.hide(); return; }
    var seconds = Math.max(0, Math.ceil((snap.expiresAt - Date.now()) / 1000));
    var time = seconds ? Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') : (snap.expiresAt ? 'expired' : 'cold');
    var available = seconds ? snap.reusable : 0;
    var format = function (value) { return Math.round(value).toLocaleString('en-US'); };
    item.text = '$(history) Cache ' + time + (available > 0 ? ' ~' + (available >= 1000 ? (available / 1000).toFixed(1) + 'K' : format(available)) : '');
    var tip = new vscode.MarkdownString();
    tip.appendMarkdown('**Devin prompt cache**\n\n');
    tip.appendMarkdown('Model: `' + snap.uid + '`\n\n');
    tip.appendMarkdown(seconds ? 'Prompt cache expires in **' + time + '**\n\n' : 'No live cache window for this model/request.\n\n');
    tip.appendMarkdown('Reusable prefix (estimated upper bound): **~' + format(available) + ' tokens**\n\n');
    tip.appendMarkdown('Last request cached read: **' + (snap.actualRead === null ? '~' + format(snap.estimatedRead) + ' (estimated; server did not report)' : format(snap.actualRead) + ' (server)') + '**\n\n');
    if (snap.write > 0) { tip.appendMarkdown('Cache write: **' + format(snap.write) + '** (not a cached-read discount)\n\n'); }
    tip.appendMarkdown('5-minute client window, matching Devin Desktop. Expiry and prefix matching are estimates, not a backend hit guarantee. No background chat pings are sent.');
    item.tooltip = tip;
    item.show();
  }

  function installPromptCacheWindow(context) {
    if (promptCacheUi.item || !vscode.window || typeof vscode.window.createStatusBarItem !== 'function') { return; }
    var item = vscode.window.createStatusBarItem('gcmp.statusBar.devinCache', vscode.StatusBarAlignment.Right, 12);
    item.name = 'GCMP: Devin Prompt Cache';
    promptCacheUi.item = item;
    promptCacheUi.timer = setInterval(renderPromptCacheWindow, 1000);
    if (promptCacheUi.timer.unref) { promptCacheUi.timer.unref(); }
    if (context && context.subscriptions) {
      context.subscriptions.push({ dispose: function () {
        clearInterval(promptCacheUi.timer);
        item.dispose();
        promptCacheUi.item = null;
        promptCacheUi.timer = null;
      } });
    }
    renderPromptCacheWindow();
  }

  var assistantMeta = new Map();       // 'session|uid' -> Map(fingerprint -> { thinking, signature, signatureType })
  var assistantMetaByCall = new Map(); // 'call:<id>' -> meta - server tool-call ids are unique per turn
  var META_STATE_VERSION = 1;
  var META_STATE_TTL_MS = 72 * 60 * 60 * 1000;

  /* Signatures live in memory only unless persisted: a window reload used to drop every
     historical #11/#12/#18 echo, the wire bytes flipped signed->unsigned, the server-side
     prefix entry was invalidated, and the session stayed cache-broken at the first unsigned
     assistant message for the rest of its life. */
  function metaStatePath() {
    var p = prefixStatePath();
    return p ? nodePath.join(nodePath.dirname(p), 'devin-meta-state.json') : null;
  }

  /* a meta entry is worth keeping/echoing when ANY of its fields survived - turn ids and the
     phase flag replay even on turns whose reasoning was redacted or never captured */
  function hasAssistantMeta(meta) {
    if (!meta || typeof meta !== 'object') { return false; }
    var s = function (v) { return typeof v === 'string' && v.length > 0; };
    return s(meta.thinking) || s(meta.signature) || s(meta.signatureType) ||
      s(meta.outputId) || s(meta.thinkingId) || s(meta.phase) ||
      s(meta.geminiThoughtSignature) || meta.thinkingRedacted === true;
  }

  function decodeMetaEntry(e, cutoff) {
    if (!e || !Number.isFinite(e.at) || e.at < cutoff) { return null; }
    var meta = { thinking: typeof e.t === 'string' ? e.t : '', signature: typeof e.s === 'string' ? e.s : '',
      signatureType: typeof e.st === 'string' ? e.st : '', outputId: typeof e.oi === 'string' ? e.oi : '',
      thinkingId: typeof e.ti === 'string' ? e.ti : '', phase: typeof e.ph === 'string' ? e.ph : '',
      geminiThoughtSignature: typeof e.gs === 'string' ? e.gs : '',
      thinkingRedacted: e.tr === true, at: e.at };
    return hasAssistantMeta(meta) ? meta : null;
  }

  function loadMetaState() {
    var file = metaStatePath();
    if (!file || !fs.existsSync(file)) { return 0; }
    var state = null;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return 0; }
    if (!state || state.version !== META_STATE_VERSION) {
      try { fs.renameSync(file, file + '.legacy.quarantine.' + crypto.randomUUID() + '.json'); } catch (e) { /* stale file - leave it */ }
      return 0;
    }
    var cutoff = Date.now() - META_STATE_TTL_MS;
    var loaded = 0;
    Object.keys(state.namespaces || {}).forEach(function (ns) {
      var entries = state.namespaces[ns];
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) { return; }
      var m = assistantMetaNamespace(ns);
      Object.keys(entries).forEach(function (fp) {
        var meta = decodeMetaEntry(entries[fp], cutoff);
        if (meta && m.size < ASSISTANT_META_LIMIT) { m.set(fp, meta); loaded++; }
      });
    });
    Object.keys(state.calls || {}).forEach(function (k) {
      var meta = decodeMetaEntry(state.calls[k], cutoff);
      if (meta && assistantMetaByCall.size < 4096) { assistantMetaByCall.set(k, meta); }
    });
    if (loaded) { logLine('assistant meta state loaded: ' + loaded + ' entr(ies) (' + file + ')'); }
    return loaded;
  }

  function saveMetaState() {
    var file = metaStatePath();
    if (!file) { return; }
    var now = Date.now();
    try {
      var encode = function (meta) {
        return { t: meta.thinking || '', s: meta.signature || '', st: meta.signatureType || '',
          oi: meta.outputId || '', ti: meta.thinkingId || '', ph: meta.phase || '',
          gs: meta.geminiThoughtSignature || '', tr: meta.thinkingRedacted === true, at: meta.at || now };
      };
      var namespaces = {};
      assistantMeta.forEach(function (m, ns) {
        var entries = {};
        m.forEach(function (meta, fp) {
          if (hasAssistantMeta(meta)) { entries[fp] = encode(meta); }
        });
        if (Object.keys(entries).length) { namespaces[ns] = entries; }
      });
      var calls = {};
      assistantMetaByCall.forEach(function (meta, k) {
        if (hasAssistantMeta(meta)) { calls[k] = encode(meta); }
      });
      fs.mkdirSync(nodePath.dirname(file), { recursive: true });
      var tmp = file + '.' + process.pid + '.' + now + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: META_STATE_VERSION, namespaces: namespaces, calls: calls }));
      fs.renameSync(tmp, file);
    } catch (e) { /* meta is a cache: never break a request over it */ }
  }

  function clearMetaState() {
    assistantMeta.clear();
    assistantMetaByCall.clear();
    convBranches.clear();
    var file = metaStatePath();
    if (file) { try { fs.unlinkSync(file); } catch (e) { /* already gone */ } }
  }

  function assistantMetaNamespace(key) {
    if (!key) { return null; }
    var m = assistantMeta.get(key);
    if (!m) { m = new Map(); assistantMeta.set(key, m); }
    return m;
  }

  function canonicalJson(value) {
    if (value === null || value === undefined || typeof value !== 'object') { return value; }
    if (Array.isArray(value)) { return value.map(canonicalJson); }
    var keys = Object.keys(value).sort();
    /* null-prototype output: a JSON.parse'd own '__proto__' key would silently drop
       onto the prototype of a plain {} and vanish from the wire schema */
    var out = Object.create(null);
    for (var i = 0; i < keys.length; i++) { out[keys[i]] = canonicalJson(value[keys[i]]); }
    return out;
  }

  function normalizeArgs(args) {
    var raw = String(args || '');
    try { return JSON.stringify(canonicalJson(JSON.parse(raw))); }
    catch (e) { return raw; }
  }

  function assistantFingerprint(text, calls) {
    var material = 'text:' + String(text || '');
    if (calls && calls.length) {
      for (var i = 0; i < calls.length; i++) { material += '|call:' + (calls[i].id || '') + ':' + (calls[i].name || '') + ':' + normalizeArgs(calls[i].arguments); }
    }
    return crypto.createHash('sha1').update(material).digest('hex');
  }

  /* Meta is bound to the exact preceding wire context: identical replies ('Done.') in
     different turns must keep their own output id/signature instead of a later turn
     overwriting the namespace entry of the earlier identical text. The leaf reuses the
     wire transcript hashing with meta stripped - including it would create a hash cycle. */
  function assistantContextLeaf(m) {
    return transcriptPartsOf('', [{
      role: m && m.role, text: m && m.text, toolCalls: m && m.toolCalls,
      toolResults: m && m.toolResults, toolCallId: m && m.toolCallId,
      isError: m && m.isError, images: m && m.images,
    }]).parts[1].h;
  }

  function assistantContextFingerprint(messages) {
    var h = crypto.createHash('sha1');
    h.update('assistant-context-v1|');
    var list = messages || [];
    for (var i = 0; i < list.length; i++) { h.update(assistantContextLeaf(list[i]) + '|'); }
    return h.digest('hex');
  }

  function assistantMetaStorageKey(text, calls, contextDigest) {
    var base = assistantFingerprint(text, calls);
    return contextDigest
      ? crypto.createHash('sha1').update('context:' + contextDigest + '|' + base).digest('hex')
      : base;
  }

  function rememberAssistantMeta(text, calls, meta, key, contextDigest) {
    if (globalThis.__gcmpDevinDebug) { logLine('assistant meta: thinking=' + ((meta && meta.thinking) ? meta.thinking.length : 0) + ' sig=' + ((meta && meta.signature) ? meta.signature.length : 0) + ' type=' + ((meta && meta.signatureType) || '-') + ' gsig=' + ((meta && meta.geminiThoughtSignature) ? meta.geminiThoughtSignature.length : 0) + ' redacted=' + (!!(meta && meta.thinkingRedacted)) + ' key=' + key); }
    if (!hasAssistantMeta(meta)) { return; }
    var m = assistantMetaNamespace(key);
    if (m) {
      /* production callers pass the wire-context digest so the entry binds to THIS
         turn's preceding history; legacy 4-arg callers keep the plain fingerprint key */
      m.set(assistantMetaStorageKey(text, calls, contextDigest), meta);
      if (m.size > ASSISTANT_META_LIMIT) {
        var oldest = m.keys().next();
        if (!oldest.done) {
          m.delete(oldest.value);
          logLine('assistant meta evicted at ' + m.size + ' entries - older turns lose their thinking/signature echo');
        }
      }
    }
    var list = calls || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id) { assistantMetaByCall.set('call:' + list[i].id, meta); }
    }
    while (assistantMetaByCall.size > 2048) {
      var oldCall = assistantMetaByCall.keys().next();
      if (oldCall.done) { break; }
      assistantMetaByCall.delete(oldCall.value);
    }
    saveMetaState();
  }

  function assistantMetaFor(text, calls, key, contextDigest, allowLegacy) {
    var m = assistantMetaNamespace(key);
    var meta = null;
    if (m) {
      /* context-bound key first; the plain fingerprint is only a fallback for
         unambiguous histories (single occurrence) or legacy callers without a digest */
      if (contextDigest) { meta = m.get(assistantMetaStorageKey(text || '', calls || [], contextDigest)) || null; }
      if (!meta && (!contextDigest || allowLegacy === true)) { meta = m.get(assistantFingerprint(text || '', calls || [])) || null; }
    }
    var list = calls || [];
    for (var i = 0; !meta && i < list.length; i++) {
      /* the text fingerprint alone misses whenever the returned args were re-serialized; the
         server call id is the stable identity across turns */
      if (list[i] && list[i].id) { meta = assistantMetaByCall.get('call:' + list[i].id) || null; }
    }
    if (globalThis.__gcmpDevinDebug) { logLine('assistant meta lookup: ' + (meta ? 'hit' : 'miss') + ' (keys=' + assistantMeta.size + ')'); }
    return meta || null;
  }

  /* ------------------------------------------------------------------ *
   * message conversion
   * ------------------------------------------------------------------ */

  /* LanguageModelThinkingPart also carries a string .value - without this check the previous
     turn's chain-of-thought is inlined into the assistant message text we send back, so the
     model treats its own reasoning as reply content and starts emitting thinking AS plain
     text (the 'reasoning leaks into the chat' symptom). The reasoning still reaches the model
     through the signed #11 echo channel - it just never becomes literal reply text. */
  function isThinkingPart(p) {
    if (!p || typeof p !== 'object') { return false; }
    var ctor = vscode.LanguageModelThinkingPart;
    if (ctor && p instanceof ctor) { return true; }
    if (p.constructor && p.constructor.name === 'LanguageModelThinkingPart') { return true; }
    return typeof p.value === 'string' && p.id !== undefined && !p.callId && !p.name && !(p.mimeType && p.data);
  }

  function partText(part) {
    if (typeof part === 'string') { return part; }
    if (!part || typeof part !== 'object') { return ''; }
    if (isThinkingPart(part)) { return ''; }
    if (typeof part.value === 'string') { return part.value; }
    if (typeof part.text === 'string') { return part.text; }
    if (part.mimeType && part.data) { return '[image ' + part.mimeType + ']'; }
    if (part.callId && part.name) { return '[tool call ' + part.name + ']'; }
    if (part.callId && part.content !== undefined) { return '[tool result] ' + collectText(part.content); }
    return '';
  }

  function collectText(content) {
    if (content === undefined || content === null) { return ''; }
    if (typeof content === 'string') { return content; }
    var parts = Array.isArray(content) ? content : [content];
    var out2 = '';
    for (var i = 0; i < parts.length; i++) { out2 += partText(parts[i]); }
    return out2;
  }

  /** Text only: tool calls/results/images are carried by their own fields, not inlined here. */
  function collectPlainText(content) {
    if (content === undefined || content === null) { return ''; }
    if (typeof content === 'string') { return content; }
    var parts = Array.isArray(content) ? content : [content];
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || typeof p !== 'object') { continue; }
      if (isThinkingPart(p)) { continue; }
      if (p.callId && (p.name || p.content !== undefined)) { continue; }
      if (p.mimeType && p.data) { continue; }
      if (typeof p.value === 'string') { out += p.value; }
      else if (typeof p.text === 'string') { out += p.text; }
    }
    return out;
  }

  function roleName(role) {
    var roles = vscode.LanguageModelChatMessageRole || {};
    if (role === roles.User || role === 1) { return 'user'; }
    if (role === roles.Assistant || role === 2) { return 'assistant'; }
    if (role === roles.System || role === 3) { return 'system'; }
    return String(role);
  }

  function imageParts(content) {
    var parts = Array.isArray(content) ? content : (content ? [content] : []);
    var images = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || typeof p !== 'object' || !p.mimeType || !p.data) { continue; }
      if (String(p.mimeType).indexOf('image/') !== 0) { continue; }
      var buf = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data);
      images.push({ mime: p.mimeType, data: buf.toString('base64') });
    }
    return images;
  }

  function toolCallParts(content) {
    var parts = Array.isArray(content) ? content : (content ? [content] : []);
    var calls = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || typeof p !== 'object' || !p.callId || !p.name) { continue; }
      calls.push({ id: p.callId, name: p.name, arguments: JSON.stringify(p.input === undefined ? {} : p.input) });
    }
    return calls;
  }

  function toolResultParts(content) {
    var parts = Array.isArray(content) ? content : (content ? [content] : []);
    var results = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || typeof p !== 'object' || !p.callId || p.content === undefined) { continue; }
      results.push({
        id: p.callId,
        /* plain text only: image parts travel via results[].images, not an '[image]' marker */
        content: collectPlainText(p.content),
        status: (p.isError === true || p.status === 'error') ? 'error' : 'success',
        isError: p.isError === true,
        images: imageParts(p.content),
      });
    }
    return results;
  }

  function toRequestMessages(messages, state) {
    var system = [];
    var list = [];
    var i;
    var resultLimit = budget('toolResultLimit', TOOL_RESULT_LIMIT);
    var notificationLimit = budget('terminalNotificationLimit', TERMINAL_NOTIFY_LIMIT);
    var echoMode = reasoningEchoMode();
    var echoStats = { mode: echoMode, assistant: 0, echoed: 0, thinking: 0, signature: 0 };
    var lastAssistantIndex = -1;
    for (i = 0; i < messages.length; i++) {
      if (roleName(messages[i].role) === 'assistant') { lastAssistantIndex = i; }
    }
    /* occurrence counts of identical assistant payloads over the WHOLE history, computed
       once up front: the legacy plain-fingerprint fallback is safe only for a text+calls
       combination that appears exactly once - a repeated reply would replay the LATEST
       stored echo into an earlier turn. */
    var asstFpCounts = {};
    for (i = 0; i < messages.length; i++) {
      if (roleName(messages[i].role) !== 'assistant') { continue; }
      var fpText = collectPlainText(messages[i].content);
      var fpCalls = toolCallParts(messages[i].content);
      if (!fpText.trim() && !fpCalls.length) { continue; }
      var fpKey = assistantFingerprint(fpText, fpCalls);
      asstFpCounts[fpKey] = (asstFpCounts[fpKey] || 0) + 1;
    }
    /* incremental context digest over the converted wire list: before each assistant
       meta lookup, fold only the entries appended since the last lookup and snapshot
       with hash.copy() - linear, no O(n^2) re-hashing, meta fields never enter it */
    var ctxHash = crypto.createHash('sha1').update('assistant-context-v1|');
    var ctxProcessed = 0;
    for (i = 0; i < messages.length; i++) {
      var role = roleName(messages[i].role);
      var text = collectPlainText(messages[i].content);
      var images = (role === 'user') ? imageParts(messages[i].content) : [];
      var calls = role === 'assistant' ? toolCallParts(messages[i].content) : [];
      var results = toolResultParts(messages[i].content);
      for (var ri = 0; ri < results.length; ri++) {
        results[ri].content = retargetResultText(results[ri].content, true, resultLimit);
      }
      if (role === 'system') { if (text.trim()) { system.push(text); } continue; }
      if (role === 'assistant') {
        if (text.trim() || calls.length) {
          echoStats.assistant++;
          while (ctxProcessed < list.length) { ctxHash.update(assistantContextLeaf(list[ctxProcessed]) + '|'); ctxProcessed++; }
          var ctxDigest = ctxHash.copy().digest('hex');
          var fpThis = assistantFingerprint(text, calls);
          var meta = assistantMetaFor(text, calls, (state && state.metaKey) || null, ctxDigest,
            (asstFpCounts[fpThis] || 0) === 1);
          /* reasoningEcho gates the reasoning bytes only - outputId/thinkingId/phase (and the
             redaction flag) replay on every stored turn regardless of 'never'/'newest' */
          var echoReasoning = echoMode === 'always' || (echoMode === 'newest' && i === lastAssistantIndex);
          if (meta && !echoReasoning) {
            /* clone, never mutate the cache entry: a later turn may legitimately re-echo it */
            meta = {
              thinking: '', signature: '', signatureType: '', geminiThoughtSignature: '',
              thinkingRedacted: meta.thinkingRedacted === true,
              outputId: meta.outputId || '', thinkingId: meta.thinkingId || '',
              phase: meta.phase || '', at: meta.at || 0,
            };
            if (!hasAssistantMeta(meta)) { meta = null; }
          }
          if (meta) {
            echoStats.echoed++;
            echoStats.thinking += (meta.thinking || '').length;
            echoStats.signature += (meta.signature || '').length;
          }
          list.push({
            role: 'assistant',
            text: text,
            images: [],
            toolCalls: calls,
            toolResults: [],
            meta: meta,
          });
        }
      } else if (text.trim() || images.length) {
        var markers = '';
        for (var k = 0; k < images.length; k++) { markers += '[Image ' + (k + 1) + ': pasted image]\n\n'; }
        list.push({ role: 'user', text: markers + trimNotification(text, notificationLimit), images: images, toolCalls: [], toolResults: [] });
      }
      /* tool results are their own messages in the Devin wire format (source = 4) */
      for (var rj = 0; rj < results.length; rj++) {
        list.push({
          role: 'tool',
          text: results[rj].content || '',
          images: results[rj].images || [],
          toolCalls: [],
          toolResults: [],
          toolCallId: results[rj].id,
          isError: results[rj].status === 'error' || results[rj].isError === true,
        });
      }
    }
    payloadEchoMode = echoMode;
    if (echoStats.assistant) {
      logLine('reasoning echo [' + echoMode + ']: ' + echoStats.echoed + '/' + echoStats.assistant + ' assistant turns carry #11/#12 (' +
        echoStats.thinking + 'B thinking + ' + echoStats.signature + 'B signature)');
    }
    return { system: system.join('\n\n'), messages: list, echo: echoStats };
  }

  /* ------------------------------------------------------------------ *
   * provider
   * ------------------------------------------------------------------ */

  function defaultPricing() { return pricingFor(family_default_uid(SWE_FAMILIES[0])); }

  function family_default_uid(family) {
    if (family.variantFamily) { return family.defaultUid; }
    for (var k = 0; k < family.effort.length; k++) {
      if (family.effort[k][0] === family.default) { return family.effort[k][2]; }
    }
    return (family.effort[0] && family.effort[0][2]) || 'swe-2-high';
  }

  function family_default_effort_model() { return family_default_uid(SWE_FAMILIES[0]); }

  /** concrete swe-2 uid for an effort key - pins side-request kinds (summary, explore) to a
     fixed cheap tier regardless of the effort chip the parent session runs at */
  function swe2UidFor(effortKey) {
    var fams = activeFamilies();
    for (var i = 0; i < fams.length; i++) {
      var rows = fams[i].effort || [];
      for (var j = 0; j < rows.length; j++) {
        if (rows[j][0] === effortKey && /^swe-2/.test(String(rows[j][2]))) { return rows[j][2]; }
      }
    }
    return null;
  }

  function gptLunaUidFor(effortKey) {
    var family = familyOf('devin-gpt-6-luna');
    if (!family || !family.variantFamily) {
      throw new Error('Devin GPT-6 Luna is missing from the model catalog');
    }
    /* Native selection checks disabled/live-only rows and never substitutes a
       priority or lower-effort variant for the requested Medium/High tier. */
    return nativeModels.resolve(family, { reasoningEffort: effortKey, fastMode: 'standard' });
  }

  /* The dedicated compactor produces a short continuation summary for every Devin
     family; sending GPT history to a general-purpose Luna reasoning model kept
     far more context after compaction than the SWE path. A catalog-disabled
     compactor is an error in both the host and the nested compaction paths. */
  function summaryUidFor(uid) {
    void uid;
    var target = 'compactor';
    var entry = catalogState.byUid[target];
    if (entry && entry.disabled) {
      throw new Error('summarization target "' + target + '" is disabled in the Devin catalog');
    }
    return target;
  }

  function requestAgentName(messages) {
    var name = null;
    for (var i = 0; i < (messages || []).length; i++) {
      var message = messages[i] || {};
      var role = roleName(message.role);
      var text = collectPlainText(message.content);
      // Copilot can render custom instructions as a leading user-message carrier.
      var carrier = role === 'user' && /^\s*When generating code, please follow these user provided coding instructions\./.test(text);
      if (role !== 'system' && !carrier) { break; }
      var tags = /```[\s\S]*?```|~~~[\s\S]*?~~~|<\/?([A-Za-z][\w-]*)(?:\s+[^<>]*?)?\s*\/?>/g;
      var stack = [];
      var modeStart = -1;
      var match;
      while ((match = tags.exec(text))) {
        if (!match[1]) { continue; }
        var tag = match[1];
        if (match[0].slice(0, 2) === '</') {
          if (stack[stack.length - 1] !== tag) { continue; }
          stack.pop();
          if (tag === 'modeInstructions' && stack.length === 0 && modeStart >= 0) {
            var header = /^\s*You are currently running in "([^"\r\n]+)" mode\.\s*Below are your instructions for this mode, they must take precedence over any instructions above\./.exec(text.slice(modeStart, match.index));
            if (header) {
              if (name !== null) { return null; }
              name = header[1];
            }
            modeStart = -1;
          }
        } else if (!/\/>$/.test(match[0])) {
          if (tag === 'modeInstructions' && stack.length === 0) { modeStart = tags.lastIndex; }
          stack.push(tag);
        }
      }
      if (carrier) { break; }
    }
    return name;
  }

  /** Swap the hardcoded SWE table for the live catalog once it arrives. */
  function activeFamilies() {
    if (catalogState.families && catalogState.families.length) { return catalogState.families; }
    return SWE_FAMILIES.concat(nativeModels.buildFamilies([]));
  }

  function rebuildModels(provider) {
    var families = activeFamilies();
    provider.models = families.map(function (family) { return modelEntry(family); });
    logLine('models: ' + provider.models.map(function (m) { return m.id; }).join(', '));
    try { provider.emitter.fire(); } catch (e) { /* noop */ }
    return provider.models;
  }

  /* Total context ceiling for a non-SWE family: the MINIMUM valid positive ceiling across the
     family's effort rows is the only window every variant can serve (row[3] = catalog
     maxTokens); family.maxInput and the default uid's catalog meta are fallbacks. A family
     with no usable total is rejected outright - never silently clamped to a shared preset. */
  function familyContextTotal(family, defaultUid) {
    var best = 0;
    var rows = (family && family.effort) || [];
    for (var i = 0; i < rows.length; i++) {
      var ceiling = Number(rows[i][3]);
      if (Number.isFinite(ceiling) && ceiling > 0 && (!best || ceiling < best)) { best = ceiling; }
    }
    if (!best && family && Number.isFinite(family.maxInput) && family.maxInput > 0) { best = family.maxInput; }
    if (!best) {
      var meta = catalogMeta(defaultUid || (family && family_default_uid(family)));
      if (meta && Number.isFinite(meta.maxTokens) && meta.maxTokens > 0) { best = meta.maxTokens; }
    }
    if (!Number.isFinite(best) || best <= MAX_OUTPUT_TOKENS) {
      throw new Error('Devin ' + ((family && family.name) || 'model') + ' has no usable context budget (' + best + ' total, output ' + MAX_OUTPUT_TOKENS + ')');
    }
    return best;
  }

  /** Label for a TOTAL context window (input + output): '1M' at 1000000, else rounded K. */
  function contextTotalLabel(total) {
    return total >= 1000000 ? (total / 1000000) + 'M' : Math.round(total / 1000) + 'K';
  }

  var GPT_CONTEXT_PRESETS = [[336000, '400K'], [536000, '600K'], [736000, '800K'], [936000, '1M']];
  var gptContextWindows = new Map();

  function isGptFamily(family) { return family && /^gpt-/.test(String(family_default_uid(family))); }

  function gptContextPresets(ceiling) {
    var presets = GPT_CONTEXT_PRESETS.filter(function (row) { return row[0] <= ceiling; });
    return presets.length ? presets : [[ceiling, contextTotalLabel(ceiling + MAX_OUTPUT_TOKENS)]];
  }

  function gptContextInput(family, configuration, ceiling) {
    var presets = gptContextPresets(ceiling);
    var picked = configuration && Object.prototype.hasOwnProperty.call(configuration, 'contextSize')
      ? Number(configuration.contextSize) : gptContextWindows.get(family.id);
    if (picked === 400000 || picked === 600000 || picked === 800000 || picked === 1000000) { picked -= MAX_OUTPUT_TOKENS; }
    return presets.some(function (row) { return row[0] === picked; }) ? picked : presets[presets.length - 1][0];
  }

  function modelEntry(family) {
    if (family.variantFamily) { return nativeModelEntry(family); }
    var effortEnum = family.effort.map(function (row) { return row[0]; });
    var effortLabels = family.effort.map(function (row) { return row[1]; });
    var catalogMax = family.maxInput || 0;
    var defaultUid = family_default_uid(family);
    var meta = catalogMeta(defaultUid);
    var p = pricingFor(defaultUid);
    var credits = (meta && meta.creditMultiplier) ? (meta.creditMultiplier + ' credits') : 'credits n/a';
    var contextEnum, contextLabels, ctx, detailCtx;
    if (/^swe-/.test(String(defaultUid))) {
      /* the picked preset is the budget VS Code compacts against; the catalog's 262000
         is a floor label, not the window - the swe-2 backend serves single prompts
         past 1M input tokens */
      var presets = CONTEXT_PRESETS;
      contextEnum = presets.map(function (row) { return row[0]; });
      contextLabels = presets.map(function (row) { return row[1]; });
      var catalogCtx = (meta && meta.maxTokens) ? meta.maxTokens : (catalogMax || 0);
      ctx = REPORTED_WINDOW;
      if (catalogCtx && catalogCtx !== ctx) {
        logLine('context window: reporting ' + ctx + ' while the catalog says ' + catalogCtx +
          ' (VS Code compacts near ' + Math.round((ctx * 0.8) / 1100) + 'K of real prompt)');
      }
      detailCtx = contextTotalLabel(ctx + MAX_OUTPUT_TOKENS);
    } else {
      /* non-SWE backends use their own total context minus the output budget. GPT offers
         independent 400K/600K/800K/1M tiers; other families keep the full catalog window.
         Shared SWE presets never set these models' budgets, and invalid old picks migrate
         to a supported tier rather than retaining the wrong family budget. */
      var total = familyContextTotal(family, defaultUid);
      var ceiling = total - MAX_OUTPUT_TOKENS;
      var gptPresets = isGptFamily(family) ? gptContextPresets(ceiling) : [[ceiling, contextTotalLabel(total)]];
      ctx = isGptFamily(family) ? gptContextInput(family, null, ceiling) : ceiling;
      contextEnum = gptPresets.map(function (row) { return row[0]; });
      contextLabels = gptPresets.map(function (row) { return row[1]; });
      detailCtx = contextTotalLabel(ctx + MAX_OUTPUT_TOKENS);
    }
    return {
      id: family.id,
      name: 'Devin - ' + family.name,
      family: /^swe-/.test(String(defaultUid)) ? 'devin-swe' : 'devin-native',
      version: family.id,
      detail: 'Devin ' + family.name + ' - ' + detailCtx + ' ctx - ' + credits,
      tooltip: family.tip + ' - context window ' + ctx + ' tokens, ' + credits + ' per request',
      maxInputTokens: Math.max(32000, ctx),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      capabilities: { toolCalling: true, imageInput: true },
      isBYOK: true,
      isUserSelectable: true,
      inputCost: (p && p.input) || null,
      outputCost: (p && p.output) || null,
      cacheCost: (p && p.cacheRead) || null,
      cacheWriteCost: 0,
      configurationSchema: {
        properties: {
          reasoningEffort: {
            type: 'string',
            title: 'Reasoning Effort',
            enum: effortEnum,
            enumItemLabels: effortLabels,
            default: family.default,
            group: 'navigation',
          },
          contextSize: {
            type: 'number',
            title: 'Context Window',
            enum: contextEnum,
            enumItemLabels: contextLabels,
            default: isGptFamily(family) ? contextEnum[contextEnum.length - 1] : CONTEXT_DEFAULT,
            group: 'tokens',
          },
        },
      },
    };
  }

  /** Native variant family entry: the devin-models module owns the variant
     table, display pricing, and the Effort/Fast Mode toggle schema. */
  function nativeModelEntry(family) {
    var nativeInput = nativeModels.contextInput(family, MAX_OUTPUT_TOKENS);
    var props = nativeModels.properties(family);
    /* GPT exposes independent input budgets with 64K reserved output; other native
       families keep their full ceiling. None of these choices reuse the SWE presets. */
    var presets = isGptFamily(family) ? gptContextPresets(nativeInput) : [[nativeInput, contextTotalLabel(family.maxInput)]];
    var ctxEnum = presets.map(function (row) { return row[0]; });
    var ctxLabels = presets.map(function (row) { return row[1]; });
    var reportedInput = isGptFamily(family) ? gptContextInput(family, null, nativeInput) : nativeInput;
    props.contextSize = {
      type: 'number',
      title: 'Context Window',
      enum: ctxEnum,
      enumItemLabels: ctxLabels,
      default: ctxEnum[ctxEnum.length - 1],
      group: 'tokens',
    };
    var tip = family.tip;
    /* the card's price line is the STANDARD default row: when the family's picked
       defaultEntry is itself a fast/priority variant (a fast-only live subset),
       quoting its doubled rates as the standard price would lie about the chip.
       Same-effort non-fast row first, then any other non-fast variant; a
       fast-only family reports no standard price at all (null, never the fast
       rates relabeled). */
    var defaultSel = nativeModels.selection(family.defaultEntry);
    var stdEntry = defaultSel.fastMode !== true ? family.defaultEntry :
      (family.variants.find(function (entry) {
        var sel = nativeModels.selection(entry);
        return sel.fastMode !== true && sel.reasoningEffort === defaultSel.reasoningEffort;
      }) || family.variants.find(function (entry) {
        return nativeModels.selection(entry).fastMode !== true;
      }) || null);
    var np = stdEntry ? nativeModels.displayPricing(stdEntry.uid) : null;
    var stdMeta = stdEntry ? catalogMeta(stdEntry.uid) : null;
    var stdMult = (stdMeta && Number.isFinite(stdMeta.creditMultiplier)) ? stdMeta.creditMultiplier : null;
    var detail = 'Devin ' + family.name + ' - ' + contextTotalLabel(reportedInput + MAX_OUTPUT_TOKENS) + ' ctx (native) - ' +
      (stdEntry ? 'Standard default' : 'Fast only - no standard variant') +
      (stdMult !== null ? ' - x' + stdMult + ' credit multiplier' : '');
    return {
      id: family.id,
      name: 'Devin - ' + family.name,
      family: 'devin-native',
      version: family.id,
      detail: detail,
      tooltip: tip + ' - request pricing follows the selected Standard/Fast UID; charged credits use the server report',
      maxInputTokens: reportedInput,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      capabilities: { toolCalling: true, imageInput: family.defaultEntry.supportsImages !== false },
      isBYOK: true,
      isUserSelectable: true,
      inputCost: np ? np.input : null,
      outputCost: np ? np.output : null,
      cacheCost: np ? np.cacheRead : null,
      cacheWriteCost: np ? np.cacheWrite : 0,
      configurationSchema: { properties: props },
    };
  }

  function familyOf(modelId) {
    var families = activeFamilies();
    for (var i = 0; i < families.length; i++) {
      if (families[i].id === modelId) { return families[i]; }
    }
    return null;
  }

  /** model id + configuration -> concrete Devin model uid */
  function resolveDevinModel(modelId, modelConfiguration) {
    var family = familyOf(modelId);
    if (!family) { return /^swe-/.test(String(modelId)) ? modelId : null; }
    /* an unsupported toggle combination throws in devin-models - no silent fallback uid */
    if (family.variantFamily) { return nativeModels.resolve(family, modelConfiguration || {}); }
    var wanted = modelConfiguration && modelConfiguration.reasoningEffort;
    for (var i = 0; i < family.effort.length; i++) {
      if (family.effort[i][0] === wanted) { return family.effort[i][2]; }
    }
    for (i = 0; i < family.effort.length; i++) {
      if (family.effort[i][0] === family.default) { return family.effort[i][2]; }
    }
    return family.effort[0][2];
  }

  function resolveContext(model, modelConfiguration) {
    /* variant families carry their own window: contextSize is a raw input
       budget there, clamped to the family ceiling, never the shared preset global */
    var vfamily = familyOf(model && model.id);
    if (vfamily && vfamily.variantFamily) {
      /* GPT uses its chosen valid tier, including persisted input budgets. Other native
         families retain their full ceiling; stale SWE preset values cannot migrate into
         the GPT tier set or alter the shared SWE window. */
      var ceiling = nativeModels.contextInput(vfamily, MAX_OUTPUT_TOKENS);
      return { input: isGptFamily(vfamily) ? gptContextInput(vfamily, modelConfiguration, ceiling) : ceiling, output: MAX_OUTPUT_TOKENS };
    }
    /* non-SWE families resolve to their single full-budget window - a leftover SWE preset
       value in the configuration must not pin the request to a SWE-tier budget */
    if (vfamily && !/^swe-/.test(String(family_default_uid(vfamily)))) {
      var familyInput = familyContextTotal(vfamily) - MAX_OUTPUT_TOKENS;
      return { input: isGptFamily(vfamily) ? gptContextInput(vfamily, modelConfiguration, familyInput) : familyInput, output: MAX_OUTPUT_TOKENS };
    }
    /* one window, driven by the picked preset; VS Code compacts between 78% and 90% of it */
    void modelConfiguration;
    return {
      input: REPORTED_WINDOW || (model && model.maxInputTokens) || CONTEXT_DEFAULT,
      output: (model && model.maxOutputTokens) || MAX_OUTPUT_TOKENS,
    };
  }

  /** Catalog ceiling for the concrete model uid (0 when unknown). */
  function contextCeiling(uid) {
    var meta = catalogMeta(uid);
    return (meta && meta.maxTokens) || 0;
  }

  /**
   * The picked preset wins over the catalog label (the catalog's 262000 is a floor, not
   * the backend's real window - a single swe-2 prompt was measured past 1M input tokens);
   * the mismatch is logged once per model build in modelEntry, not per request.
   */
  function resolveContextClamped(model, modelConfiguration, uid) {
    return resolveContext(model, modelConfiguration);
  }

  function DevinProvider() {
    var self = this;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this.emitter.event;
    this.models = activeFamilies().map(modelEntry);
    this.activeCredential = null;
    this.refreshCatalog = function (force) {
      var candidates = credentialCandidates(!!force);
      if (!candidates.length) { return Promise.resolve(null); }
      /* The full catalog (GPT-6 Astra / Claude Opus 5 / Claude Fable 5.1) is what the Devin
         Desktop credential sees; a CLI-flavored token can come back SWE-only. Prefer the desktop
         credential for the catalog fetch and pin it as the active chat credential so the models
         we list are exactly the models this credential can serve. */
      var pick = candidates[0];
      for (var ci = 0; ci < candidates.length; ci++) {
        if (candidates[ci].source === 'devin-desktop') { pick = candidates[ci]; break; }
      }
      return loadCatalog(pick, !!force).then(function (state) {
        if (state && state.families && state.families.length) {
          self.activeCredential = pick;
          rebuildModels(self);
        }
        return state;
      });
    };

    this._send = function (model, messages, handlers, tools, forceCredential, state) {
      var candidates = credentialCandidates(!!forceCredential);
      if (!candidates.length) { return Promise.reject(new Error(credentialHint())); }
      state = state || newRequestState();
      state.sessionId = state.sessionId || conversationId(messages);
      state.metaKey = state.metaKey || (state.sessionId + '|' + model);
      var conv = state.conv || toRequestMessages(messages, state);
      state.assistantContextDigest = state.assistantContextDigest || assistantContextFingerprint(conv.messages);
      /* main requests replay stored compactions so state.conv tracks the effective wire
         history (the caller keeps re-sending the pre-compaction transcript) */
      if (!state.kind || state.kind === 'main-agent') {
        var appliedConv = applyConversationCompactions(state.sessionId, model, conv);
        if (appliedConv !== conv) { conv = appliedConv; }
      }
      state.conv = conv;
      state.trace = state.trace || traceContext();
      /* resolve the #15.1/#16 lineage synchronously so two parallel branches of the same
         session can never claim the same pair - the second caller already sees the first's
         registered tail and forks. Derived BEFORE the prefix lookup so the branch id can
         join the cache key of non-root lineages. */
      state.convIds = state.convIds || conversationIdsFor(state.sessionId, conv, state.kind);
      if (!state.cacheKey) {
        var rootConvId = uuidFromHash('conv|' + String(state.sessionId || 'devin-conversation'));
        state.branchId = (state.convIds && state.convIds.conv !== rootConvId) ? state.convIds.conv : null;
        state.cacheKey = cacheKey(state.sessionId, model, state.kind || 'main-agent', tools, state.branchId);
      }
      if (!state.anchorKey) {
        /* side channels (terminal steering, summaries, trackers) borrow the main branch's wire
           lineage in conversationIdsFor - their prompt extends the main baseline the server
           already cached, so the client-side estimate anchors on the same main-agent entry.
           Read-only: recordUsage commits baselines for main turns only. */
        state.anchorKey = (state.kind && state.kind !== 'main-agent')
          ? cacheKey(state.sessionId, model, 'main-agent', tools, state.branchId)
          : state.cacheKey;
      }
      state.wireTools = state.wireTools || tools;
      state.promptTokens = state.promptTokens || estimatePromptTokens(state.anchorKey, model, conv.system, conv.messages, tools, state);
      state.estimatedInput = state.estimatedInput || state.promptTokens;
      state.prefix = state.prefix || sharedPrefixWith(state.anchorKey, conv.system, conv.messages, tools);
      state.cachedEstimate = state.cachedEstimate || cachedTokensFromPrefix(state.prefix, state.promptTokens);
      var previousPrompt = (state.prefix && state.prefix.prevTokens) || 0;
      if (previousPrompt && state.promptTokens > previousPrompt * 1.6) {
        logLine('prompt ' + Math.round((state.promptTokens / previousPrompt) * 100) + '% of the previous turn of this conversation (' +
          state.promptTokens + ' vs ' + previousPrompt + ' tokens, messages=' + conv.messages.length +
          ') - the caller re-sent the history; the server can only cache the copy it has already seen');
      }
      var windowTokens = state.inputBudget || contextCeiling(model) || 0;
      if (windowTokens && state.promptTokens > windowTokens * 0.85) {
        logLine('context window usage: ~' + state.promptTokens + ' / ' + windowTokens + ' tokens (' +
          Math.round((state.promptTokens / windowTokens) * 100) + '%) - compaction is due soon');
      }
      /* postChat may compact the wire history internally on a 'prompt is too long' rejection:
         refresh every derived number so estimates/prefix/lineage track what was actually sent,
         and keep the compacted conv for any credential retry (no new usage row is opened). */
      var upstream = handlers || {};
      var sendHandlers = {};
      for (var hk in upstream) { sendHandlers[hk] = upstream[hk]; }
      sendHandlers.countPrompt = function (info) {
        return estimatePromptTokens(state.anchorKey || state.cacheKey, model, info.system, info.messages, tools);
      };
      sendHandlers.onCompacted = function (info) {
        conv = { system: (info && info.system) || conv.system, messages: (info && info.messages) || conv.messages, echo: conv.echo };
        state.conv = conv;
        /* the wire conv just changed shape: move the branch tail registered for THIS
           request's #15.1/#16 pair to the effective conv (same ids, no new fork). Without
           it the next turn re-sends the original transcript, no longer extends the stale
           tail, and forks into a cold lineage. */
        var branchList = convBranches.get(String(state.sessionId || 'devin-conversation'));
        if (branchList && state.convIds) {
          var compactTp = transcriptPartsOf(conv.system, conv.messages);
          var compactHashes = compactTp.parts.map(function (part) { return part.h; });
          for (var bi = 0; bi < branchList.length; bi++) {
            if (branchList[bi].req === state.convIds.req && branchList[bi].conv === state.convIds.conv) {
              branchList[bi].hashes = compactHashes;
              branchList[bi].at = Date.now();
            }
          }
        }
        state.promptTokens = estimatePromptTokens(state.anchorKey || state.cacheKey, model, conv.system, conv.messages, tools, state);
        state.estimatedInput = state.promptTokens;
        state.prefix = sharedPrefixWith(state.anchorKey || state.cacheKey, conv.system, conv.messages, tools);
        state.cachedEstimate = cachedTokensFromPrefix(state.prefix, state.promptTokens);
        if (upstream.onCompacted) { upstream.onCompacted(info); }
      };
      var attempt = function (index) {
        if (index >= candidates.length) { return Promise.reject(new Error('Devin request failed for every credential')); }
        var cred = candidates[index];
        state.cacheCheckedAt = Date.now();
        var selectedBudget = state.kind === 'main-agent' && /^gpt-/.test(String(model)) ? state.inputBudget : 0;
        return postChat(cred, model, conv.system, conv.messages, sendHandlers, tools, state.sessionId, state.convIds, state.kind, selectedBudget).then(function (result) {
          self.activeCredential = cred;
          return result;
        }, function (err) {
          var msg = String(err && err.message);
          logErr('credential ' + cred.source + ' failed: ' + msg);
          if (/401|403|unauthorized|authenticate/i.test(msg)) { return attempt(index + 1); }
          throw err;
        });
      };
      return attempt(0);
    };

    /* Raw seat-management unary call for the status bar / probes. method = e.g. 'GetPlanStatus'. */
    this._devinRpc = function (method, payload, headers) {
      var candidates = credentialCandidates(false);
      if (!candidates.length) { return Promise.reject(new Error(credentialHint())); }
      var cred = self.activeCredential || candidates[0];
      return rpcUnaryPath(cred, SEAT_SERVICE, method, payload || Buffer.alloc(0), headers);
    };
    /* Probes need the live key to hand-roll envelopes; expose the chosen candidate, never the raw key. */
    this._devinCredentialCandidates = function () {
      return credentialCandidates(false).map(function (c) { return { source: c.source, email: c.email, apiKey: c.apiKey }; });
    };
    /* Fetch the model catalog with one specific credential candidate (diagnostics: the catalog is
       per-token, so different candidates can return different family sets). */
    this._devinCatalog = function (index, force) {
      var candidates = credentialCandidates(false);
      var cred = candidates[index || 0];
      if (!cred) { return Promise.reject(new Error('no credential candidate at index ' + index)); }
      return loadCatalog(cred, !!force);
    };
  }

  DevinProvider.prototype.provideLanguageModelChatInformation = function () {
    return Promise.resolve(this.models.slice());
  };

  DevinProvider.prototype.provideTokenCount = function (model, value) {
    var content = value && value.content;
    var countParts = Array.isArray(content) ? content : [content];
    var text = typeof value === 'string' ? value : countParts.map(function (part) {
      if (isThinkingPart(part)) { return ''; }
      if (part && part.callId && part.name) {
        return part.name + ' ' + JSON.stringify(canonicalJson(part.input === undefined ? {} : part.input));
      }
      return partText(part);
    }).join('');
    /* VS Code compacts when the counted total nears ~80% of maxInputTokens, but raw chars/4
       runs ~35% under the server's bill - the gauge said there was headroom while the backend
       was already rejecting oversized subagent prompts. Use the measured ratio once real usage
       arrived; before that a conservative 1.35 floor keeps the count honest. The sample is the
       maximum across the same family's effort uids only - an unknown family falls back to its
       own model id; a global cross-model maximum would let one model's calibration inflate the
       count for every other model. */
    var k = 0;
    var modelId = (model && model.id) || '';
    var family = familyOf(modelId);
    var uids = family ? family.effort.map(function (row) { return row[2]; }) : [modelId];
    for (var i = 0; i < uids.length; i++) {
      var sample = tokenCalibration.get('model:' + uids[i]);
      if (Number.isFinite(sample) && sample > 0.8 && sample > k && sample <= 2.5) { k = sample; }
    }
    if (!(k > 0.8) || k > 2.5) { k = 1.35; }
    return Promise.resolve(Math.max(1, Math.round((text.length / 4) * k)));
  };

  DevinProvider.prototype.provideLanguageModelChatResponse = function (model, messages, options, progress, token) {
    var self = this;
    var modelId = (model && model.id) || '';
    var configuration = (options && options.modelConfiguration) || {};
    var declaredKind = (options && (options.requestKind || (options.modelOptions && options.modelOptions.requestKind))) || null;
    var requestKind = declaredKind || classifyRequestKind(messages, (options && options.tools) || []);
    var workerKind = requestKind === 'main-agent' || requestKind === 'search-subagent' || requestKind === 'execution-subagent';
    var agentName = workerKind ? requestAgentName(messages) : null;
    var exploreAgent = agentName === 'Explore';
    var gptParent = isGptFamily(familyOf(modelId));
    var exploreUid = null;
    if (exploreAgent && gptParent) {
      exploreUid = gptLunaUidFor('medium');
      var lunaExploreModel = (this.models || []).find(function (entry) { return entry.id === 'devin-gpt-6-luna'; });
      if (!lunaExploreModel) { throw new Error('Explore requires Devin GPT-6 Luna Medium in the model catalog'); }
      var exploreContext = Number(configuration.contextSize);
      configuration = { reasoningEffort: 'medium', fastMode: 'standard' };
      if (Number.isFinite(exploreContext) && exploreContext > 0) { configuration.contextSize = exploreContext; }
      logLine('explore subagent pinned to ' + exploreUid + ' (from ' + modelId + ')');
      model = lunaExploreModel;
      modelId = lunaExploreModel.id;
    } else if (exploreAgent && /^devin-swe-/.test(modelId)) {
      exploreUid = swe2UidFor('medium');
      var sweExploreModel = (this.models || []).find(function (entry) { return entry.id === 'devin-swe-2'; });
      if (!exploreUid || !sweExploreModel) { throw new Error('Explore requires Devin SWE-2 Medium (swe-2-medium) in the model catalog'); }
      var sweExploreContext = Number(configuration.contextSize);
      configuration = { reasoningEffort: 'medium' };
      if (Number.isFinite(sweExploreContext) && sweExploreContext > 0) { configuration.contextSize = sweExploreContext; }
      logLine('explore subagent pinned to ' + exploreUid + ' (from ' + modelId + ')');
      model = sweExploreModel;
      modelId = sweExploreModel.id;
    }
    var uid = exploreUid || resolveDevinModel(modelId, configuration);
    if (!uid) { throw new Error('Devin provider has no model for "' + modelId + '"'); }
    if (!catalogState.entries.length) { this.refreshCatalog(false); }
    var picked = Number(configuration.contextSize);
    /* totals-style picks carry the 64K output inside them (old mislabeled tiers and
       cross-family leftovers); fold it back out, then snap a stale value up to the
       smallest live tier that still covers it. Only SWE may move the shared preset:
       GPT routes have their own model-family budget. */
    if (isFinite(picked) && picked > 0 && /^swe-/.test(String(uid))) {
      if (picked === 400000 || picked === 600000 || picked === 800000 || picked === 1000000) { picked -= MAX_OUTPUT_TOKENS; }
      picked = (CONTEXT_PRESETS.find(function (row) { return row[0] === picked; }) ||
        CONTEXT_PRESETS.find(function (row) { return row[0] > picked; }) ||
        CONTEXT_PRESETS[CONTEXT_PRESETS.length - 1])[0];
      if (picked !== REPORTED_WINDOW) {
        REPORTED_WINDOW = picked;
        logLine('context window switched to ' + picked + ' (VS Code compacts near ' +
          Math.round((picked * 0.8) / 1100) + 'K of real prompt)');
        /* VS Code caches the model info: re-fire it so maxInputTokens (the compaction budget) follows */
        rebuildModels(self);
      }
    }
    var context = resolveContextClamped(model, configuration, uid);
    if (requestKind === 'main-agent' && isGptFamily(familyOf(modelId)) && gptContextWindows.get(modelId) !== context.input) {
      gptContextWindows.set(modelId, context.input);
      rebuildModels(self);
      model = self.models.find(function (entry) { return entry.id === modelId; }) || model;
    }
    var startedAt = Date.now();
    if (isSummaryKind(requestKind)) {
      /* summaryUidFor itself rejects a catalog-disabled target (covers the nested
         compactor path too) - a summary never silently lands on a fallback uid */
      var summaryTarget = summaryUidFor(uid);
      if (summaryTarget !== uid) {
        logLine('summarization pinned to compactor (was ' + uid + ')');
        uid = summaryTarget;
      }
    }
    /* summary rows show the backend that actually produced the compact history */
    var usageFamilyId = (isSummaryKind(requestKind) && uid === 'compactor') ? 'devin-compactor' : modelId;
    var state = newRequestState();
    state.kind = requestKind;
    state.inputBudget = context.input;
    state.startedAt = startedAt;
    state.sessionId = conversationId(messages);
    state.trace = traceContext();
    state.familyId = usageFamilyId;
    /* the turn signature is the message count: a follow-up carries >= the older turn's count, a title
       /summary sub-call reusing the leading user message carries fewer - retire only a true successor */
    state.msgCount = messages.length;
    state.firstUser = messages.length ? collectText(messages[0].content) : '';
    state.turn = 'id:' + state.sessionId;
    var toolDefs = [];
    var requestTools = (options && options.tools) || [];
    for (var ti = 0; ti < requestTools.length; ti++) {
      var rt = requestTools[ti];
      toolDefs.push({ name: rt.name, description: rt.description || '', inputSchema: canonicalJson(rt.inputSchema) });
    }
    toolDefs.sort(function (a, b) { return String((a && a.name) || '').localeCompare(String((b && b.name) || '')); });
    /* a summarization prompt is text-in/text-out and never invokes a tool - shipping 88 tool
       schemas (~17K tokens) on it only inflates the request for no benefit. Strip them on
       the wire; the estimate/cacheKey follow suit. */
    var wireTools = isSummaryKind(requestKind) ? [] : toolDefs;
    state.wireTools = wireTools;
    /* the meta namespace is the conversation+model only: a tool-schema or kind change must not
       orphan the thinking/signature echo of the same history */
    state.metaKey = state.sessionId + '|' + uid;
    state.conv = toRequestMessages(messages, state);
    /* the result meta binds to the ORIGINAL host-wire history (before any compaction
       rebase): next turn the caller re-sends that same transcript and the assistant
       reply resolves its echo through this context digest */
    state.assistantContextDigest = assistantContextFingerprint(state.conv.messages);
    /* replay any stored compaction for this session+uid: the caller re-sends the ORIGINAL
       transcript, so lineage/estimates must be derived from the effective rebuilt conv */
    if (requestKind === 'main-agent') {
      var appliedConv = applyConversationCompactions(state.sessionId, uid, state.conv);
      if (appliedConv !== state.conv) { state.conv = appliedConv; }
    }
    /* resolve the #15.1/#16 lineage here - synchronously per call, so two parallel branches of
       the same session can never claim the same pair: the second caller already sees the
       first's registered tail and forks. Derived before the cache key so a non-root branch id
       can join it. */
    state.convIds = conversationIdsFor(state.sessionId, state.conv, requestKind);
    var rootConvId = uuidFromHash('conv|' + String(state.sessionId || 'devin-conversation'));
    state.branchId = (state.convIds && state.convIds.conv !== rootConvId) ? state.convIds.conv : null;
    /* open the row with a full estimate (system + history + tool schemas, calibrated against the
       server's own prompt): the dashboard used to show a number ~35% below the real prompt */
    state.cacheKey = cacheKey(state.sessionId, uid, requestKind, wireTools, state.branchId);
    /* side-channel requests (terminal steering, summaries, trackers) already borrow the main
       branch's wire lineage in conversationIdsFor - the server serves their prompt from the
       same cached head. Anchor the client-side estimate on the main-agent baseline too:
       keying the lookup on the side channel's own kind made every steer/notification row
       report a cold 0% cache although the wire bytes extended the cached transcript.
       Read-only borrow: recordUsage commits baselines for main turns only, so a differently
       shaped side prompt can never replace the lineage's confirmed prefix. */
    state.anchorKey = (requestKind && requestKind !== 'main-agent')
      ? cacheKey(state.sessionId, uid, 'main-agent', wireTools, state.branchId)
      : state.cacheKey;
    retireStaleGenerations(state);
    trackGeneration(state);
    state.promptTokens = estimatePromptTokens(state.anchorKey, modelId, state.conv.system, state.conv.messages, wireTools, state);
    state.estimatedInput = state.promptTokens;
    state.prefix = sharedPrefixWith(state.anchorKey, state.conv.system, state.conv.messages, wireTools);
    state.cachedEstimate = cachedTokensFromPrefix(state.prefix, state.promptTokens);
    updatePromptCacheWindow(state, uid, null);
    /* prefix ownership is claimed BEFORE beginUsage and independent of the usage manager:
       the confirmed-token commit must survive a manager-less or row-less request */
    prefixOwners.set(state.cacheKey, state);
    beginUsage(state, usageFamilyId, uid, messages, requestKind, context.input, state.estimatedInput);
    logLine('request: kind=' + requestKind + ' model=' + modelId + ' -> ' + uid + ' effort=' + (configuration.reasoningEffort || 'default') +
      ' context=' + context.input + '+' + context.output + ' messages=' + messages.length +
      ' tools=' + (((options && options.tools) || []).length) + ' tools=full' +
      (state.convIds ? (' conv=' + String(state.convIds.conv).slice(0, 8) + (state.convIds.fork ? '(fork)' : '')) : ''));
    var cancelFn = null;
    var thinking = '';
    var thinkingPartCtor = vscode.LanguageModelThinkingPart || null;
    var thinkingChain = makeThinkingChain(thinkingPartCtor);
    function endThinkingChain() {
      var part = thinkingChain.end();
      if (part) { try { progress.report(part); } catch (e) { /* best effort */ } }
    }
    var onCancelSignal = function () {
      logLine('cancel requested');
      if (state.aborted) { return; }
      state.aborted = true;
      if (cancelFn) { cancelFn(); }
      closeUsageNow(state, 'cancelled by the editor');
      if (state.finish) { try { state.finish(); } catch (e) { /* noop */ } }
    };
    var sub = token && token.onCancellationRequested ? token.onCancellationRequested(onCancelSignal) : null;
    /* the token may already be cancelled before this provider ran - the event will never
       fire again, so honor the flag directly */
    if (token && token.isCancellationRequested) { onCancelSignal(); }
    var reportedCalls = {};
    var lastUsageReport = 0;
    function usagePayload(usageSoFar) {
      var norm = normalizeUsage(state, usageSoFar);
      var input = norm.prompt;
      var output = norm.output;
      var cached = norm.cached;
      return {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input + output,
        prompt_tokens_details: { cached_tokens: cached },
      };
    }
    function reportUsage(usageSoFar) {
      if (!vscode.LanguageModelDataPart) { return; }
      try {
        var payload = usagePayload(usageSoFar);
        progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(payload)), 'usage'));
      } catch (e) { /* usage is best effort */ }
    }
    var contentStarted = false;
    var lateThinkingChars = 0;
    var sendPromise = this._send(uid, messages, {
      onText: function (text) {
        contentStarted = true;
        endThinkingChain();
        progress.report(new vscode.LanguageModelTextPart(text));
      },
      onThinking: function (text) {
        thinking += text;
        if (isSummaryKind(requestKind)) { return; }
        if (contentStarted) {
          /* reasoning that arrives after the answer started stays out of the message body -
             it is kept for the #11 echo so the model still sees its own chain */
          lateThinkingChars += text.length;
          return;
        }
        var part = thinkingChain.append(text);
        if (part) {
          try { progress.report(part); } catch (e) { /* thinking is best effort */ }
        }
        if (globalThis.__gcmpDevinDebug) { logLine('thinking: ' + text.slice(0, 200)); }
      },
      onToolCallStart: function (callId, name) {
        /* a call header only announces the id+name - arguments may still be streaming and the
           call itself is only emitted at stream end. Closing the thinking chain (and marking
           content started) here would cut reasoning off early; defer both to onToolCall. */
        logLine('tool call ' + name + ' (' + callId + ')');
      },
      onToolCall: function (call) {
        contentStarted = true;
        endThinkingChain();
        /* arguments arrive normalized+validated upstream (malformed batches reject before any
           call is emitted) - parse once, never fall back to {} or {raw}. A throwing
           progress.report must propagate: marking the call reported BEFORE delivery would
           make the stream-end replay skip it and silently lose the invocation. */
        var parsedArgs = JSON.parse(call.arguments || '{}');
        logLine('tool call complete ' + call.name + ' (' + call.id + ')');
        progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parsedArgs));
        reportedCalls[call.id] = true;
      },
      onUsage: function (usageSoFar) {
        var now = Date.now();
        if (now - lastUsageReport < 800) { return; }
        lastUsageReport = now;
        reportUsage(usageSoFar);
      },
      onRequestStart: function (at) { state.cacheCheckedAt = at; },
      /* a retry streams fresh reasoning - without this reset the failed attempt's thinking
         would stay accumulated (double #11 echo, corrupting the signature chain) and its
         reported parts would merge with the new attempt's block in the UI */
      onAttemptStart: function (n) {
        if (!n) { return; }
        endThinkingChain();
        thinking = '';
        lateThinkingChars = 0;
        contentStarted = false;
      },
      /* the token may already be cancelled before postChat hooks in - a recorded-but-never-
         fired fn would still send the request, so fire it immediately on registration */
      onCancel: function (fn) { cancelFn = fn; state.cancel = fn; if (state.aborted) { try { fn(); } catch (e) { /* noop */ } } },
    }, wireTools, false, state).then(function (result) {
      if (sub) { try { sub.dispose(); } catch (e) { /* noop */ } }
      endThinkingChain();
      finishGeneration(state);
      state.cancel = null;
      if (state.aborted) {
        /* retired (or cancelled) while still streaming: its row is already closed as cancelled */
        logLine('retired stream finished after cancellation - row left as cancelled, no usage written');
        return undefined;
      }
      var calls = (result && result.toolCalls) || [];
      for (var i = 0; i < calls.length; i++) {
        if (reportedCalls[calls[i].id]) { continue; }
        var parsed = JSON.parse(calls[i].arguments || '{}');
        logLine('tool call complete ' + calls[i].name + ' (' + calls[i].id + ') at stream end');
        progress.report(new vscode.LanguageModelToolCallPart(calls[i].id, calls[i].name, parsed));
      }
      var doneNorm = normalizeUsage(state, result && result.usage);
      if (result && result.usage && (result.usage.inputPresent || result.usage.cachePresent || result.usage.output)) { reportUsage(result.usage); }
      rememberAssistantMeta((result && result.text) || '', calls, {
        thinking: thinking,
        signature: result && result.signature,
        signatureType: result && result.signatureType,
        outputId: result && result.usage && result.usage.outputId,
        thinkingId: result && result.usage && result.usage.thinkingId,
        phase: result && result.usage && result.usage.phase,
        geminiThoughtSignature: result && result.usage && result.usage.geminiThoughtSignature,
        thinkingRedacted: !!(result && result.usage && result.usage.thinkingRedacted),
        at: Date.now(),
      }, state.metaKey || state.cacheKey, state.assistantContextDigest);
      if (lateThinkingChars) { logLine('late reasoning kept out of the message body: ' + lateThinkingChars + ' chars'); }
      /* the gauge tracks the whole prompt of this request, not just its cache miss - and only
         a main-agent turn may move it: a side summary's own input must never overwrite the
         active conversation's gauge. When the backend omits usage the prompt is an ESTIMATE
         of the effective conv - shown as such, never as a fake authoritative 0. */
      if (requestKind === 'main-agent') {
        var gaugeName = (model && model.name) || modelId;
        var gaugePrompt = doneNorm.prompt;
        if (!doneNorm.authoritative) {
          gaugeName += ' (estimated)';
          gaugePrompt = state.promptTokens;
        }
        pushContextUsage(gaugeName, context.input, gaugePrompt, requestKind);
      }
      recordUsage(state, uid, messages, result, startedAt);
    if (result && result.timing) {
      logLine('stream metrics: ttfb=' + result.timing.ttfb + 'ms stream=' + (result.timing.total - result.timing.ttfb) + 'ms total=' + result.timing.total + 'ms');
    }
      logLine('prompt done stop=' + ((result && result.stopReason) || '?') + ' chars=' + ((result && result.text) || '').length +
        ' tools=' + calls.length + ' prompt=' + doneNorm.prompt + ' (miss ' + doneNorm.input + ' + cache ' + doneNorm.cached + ')' +
        ' out=' + doneNorm.output + ' thinking=' + thinking.length);
      if (result && result.usage && (result.usage.input || result.usage.output)) { logLine('token record written for ' + uid); }
      return undefined;
    }, function (e) {
      if (sub) { try { sub.dispose(); } catch (e2) { /* noop */ } }
      endThinkingChain();
      finishGeneration(state);
      state.cancel = null;
      if (state.aborted) {
        /* the stream was retired by a newer request of this conversation: nothing to report */
        logLine('retired stream ended with an error, ignored: ' + ((e && e.message) || 'error'));
        return undefined;
      }
      failUsage(state, uid, startedAt, e);
      logErr('prompt failed: ' + (e && e.message));
      throw e;
    });
    /* a retired stream must still settle so VS Code's pending chat request closes */
    return new Promise(function (resolve, reject) {
      state.finish = function () { resolve(undefined); };
      sendPromise.then(function (value) { resolve(value); }, function (err) { reject(err); });
    });
  };

  /* ------------------------------------------------------------------ *
   * commands: sign-in, verify, settings
   * ------------------------------------------------------------------ */

  function startCliLogin() {
    var cli = resolveCliPath(true);
    if (!cli) { vscode.window.showErrorMessage('devin.exe not found - set "gcmp.devin.cliPath".'); return; }
    vscode.window.createTerminal({ name: 'Devin sign-in', shellPath: cli, shellArgs: ['auth', 'login'] }).show();
    logLine('started CLI OAuth login: ' + cli + ' auth login');
    vscode.window.showInformationMessage('Complete the browser sign-in in the "Devin sign-in" terminal. GCMP picks the credential up automatically once it is written.');
  }

  function cliAuthStatus(cli) {
    try {
      return cp.execFileSync(cli, ['auth', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) { return 'auth status unavailable: ' + ((e && e.message) || e); }
  }

  function verifyConnection() {
    var candidates = credentialCandidates(true);
    if (!candidates.length) { return Promise.reject(new Error(credentialHint())); }
    var errors = [];
    var familyId = (bridge.provider.models[0] && bridge.provider.models[0].id) || 'devin-swe-2';
    var modelId = resolveDevinModel(familyId, {}) || 'swe-2-max';
    function attempt(index) {
      if (index >= candidates.length) { return Promise.reject(new Error(errors.join(' | '))); }
      var cred = candidates[index];
      return postChat(cred, modelId, 'You are a connectivity probe.', [{ role: 'user', text: 'Reply with exactly: DEVIN_OK' }], {})
        .then(function (result) {
          var reply = (result.text || '').trim();
          if (!reply) { throw new Error('empty reply from ' + modelId); }
          return { credential: cred, model: familyId + ' -> ' + modelId, reply: reply };
        },
          function (e) {
            errors.push(cred.source + ': ' + ((e && e.message) || e));
            return attempt(index + 1);
          });
    }
    return attempt(0);
  }

  async function showWizard() {
    var items = [
      { label: '$(sign-in) Sign in with OAuth (browser, via Devin CLI)', action: 'login' },
      { label: '$(verified) Verify sign-in and connection', action: 'verify' },
      { label: '$(sync) Re-read credentials', action: 'reload' },
      { label: '$(key) Set API key override', action: 'key' },
      { label: '$(settings-gear) Open GCMP Devin settings', action: 'settings' },
      { label: '$(output) Show Devin provider log', action: 'log' },
    ];
    var pick = await vscode.window.showQuickPick(items, { title: 'Devin (GCMP provider)', placeHolder: 'Devin provider maintenance' });
    if (!pick) { return; }
    if (pick.action === 'log') { out().show(); return; }
    if (pick.action === 'settings') { vscode.commands.executeCommand('workbench.action.openSettings', 'gcmp.devin'); return; }
    if (pick.action === 'login') { startCliLogin(); return; }
    if (pick.action === 'key') {
      var value = await vscode.window.showInputBox({ title: 'Devin API key override', prompt: 'Devin session token / API key (leave empty to clear)', password: true, ignoreFocusOut: true });
      if (value === undefined) { return; }
      await cfg().update('apiKey', value.trim(), true);
      credCache = { value: null, at: 0 };
      vscode.window.showInformationMessage(value.trim() ? 'Devin API key override saved.' : 'Devin API key override cleared.');
      return;
    }
    if (pick.action === 'reload') {
      credCache = { value: null, at: 0 };
      var candidates = credentialCandidates(true);
      var cli = resolveCliPath(true);
      var lines = candidates.map(function (c) {
        return c.source + (c.email ? ' (' + c.email + ')' : '') + ' token=' + c.apiKey.slice(0, 22) + '...';
      });
      logLine('credentials re-read: ' + (lines.length ? lines.join(' ; ') : 'none') + ' | ' + (cli ? cliAuthStatus(cli) : 'cli missing'));
      vscode.window.showInformationMessage(lines.length ? ('Devin credentials found: ' + lines.join(' ; ')) : credentialHint());
      return;
    }
    if (pick.action === 'verify') {
      try {
        var res = await verifyConnection();
        var cliPath = resolveCliPath(false);
        var detail = 'Devin provider OK - source: ' + res.credential.source +
          (res.credential.email ? (' - account: ' + res.credential.email) : '') +
          ' - server: ' + res.credential.serverUrl +
          ' - probe model: ' + res.model + ' - reply: ' + JSON.stringify(res.reply.slice(0, 60));
        logLine(detail + (cliPath ? (' | ' + cliAuthStatus(cliPath)) : ''));
        vscode.window.showInformationMessage(detail, 'Show log').then(function (choice) { if (choice === 'Show log') { out().show(); } });
      } catch (e) {
        logErr('verification failed: ' + (e && e.message));
        vscode.window.showErrorMessage('Devin verification failed: ' + (e && e.message));
      }
    }
  }

  var bridge = { provider: null, prefixState: { load: loadPrefixState, save: savePrefixState, path: prefixStatePath, cache: prefixCache } };
  var installed = false;

  function install(context) {
    if (installed) { return []; }
    installed = true;
    var provider = new DevinProvider();
    bridge.provider = provider;
    globalThis.__gcmpDevinBridge.provider = provider;
    globalThis.__gcmpDevinBridge.prefixState = { load: loadPrefixState, save: savePrefixState, path: prefixStatePath, cache: prefixCache };
    var disposables = [];
    if (vscode.lm && typeof vscode.lm.registerLanguageModelChatProvider === 'function') {
      disposables.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));
      logLine('registered language model provider ' + VENDOR + ' (direct HTTP)');
    } else {
      logErr('vscode.lm.registerLanguageModelChatProvider is unavailable');
    }
    /* Eager catalog prefetch. The list otherwise stays at the four hardcoded SWE families until a
       chat request lazily triggers loadCatalog, so a freshly reloaded window shows an incomplete
       model picker (GPT-6 Astra / Claude Opus 5 / Claude Fable 5.1 missing). The retry loop covers
       a transiently hanging fetch (observed: one 60s timeout at window start left the picker at
       four models for the whole session). */
    (function prefetchCatalog(round) {
      provider.refreshCatalog(false).then(function () {
        var total = provider.models.length;
        logLine('catalog prefetch done: ' + total + ' model(s)' + (round ? (' (round ' + (round + 1) + ')') : ''));
        if (total <= SWE_FAMILIES.length && round < 3) {
          var delay = 15000 * (round + 1);
          logLine('catalog looks incomplete (' + total + ' models) - retrying in ' + delay + 'ms');
          setTimeout(function () { prefetchCatalog(round + 1); }, delay);
        }
      }, function (e) { logErr('catalog prefetch failed: ' + (e && e.message)); });
    })(0);
    disposables.push(vscode.commands.registerCommand(VENDOR + '.configWizard', showWizard));
    disposables.push(vscode.commands.registerCommand(VENDOR + '.login', startCliLogin));
    try {
      var credDir = devinAppData();
      if (fs.existsSync(credDir)) {
        var watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(credDir), 'credentials.toml'));
        var onCred = function () {
          credCache = { value: null, at: 0 };
          logLine('credentials.toml changed - credential cache cleared');
        };
        watcher.onDidCreate(onCred);
        watcher.onDidChange(onCred);
        disposables.push(watcher);
      }
    } catch (e) { logLine('credential watcher not installed: ' + (e && e.message)); }
    try {
      disposables.push(vscode.workspace.onDidChangeConfiguration(function (e) {
        if (e.affectsConfiguration(DEVIN_QUOTA_ITEM_ID)) {
          if (devinQuotaState.item) { if (devinQuotaVisible()) { devinQuotaState.item.show(); } else { devinQuotaState.item.hide(); } }
          devinQuotaRefresh(false);
        }
        if (!e.affectsConfiguration('gcmp.devin')) { return; }
        if (e.affectsConfiguration('gcmp.devin.deviceFingerprint')) { fingerprint = null; }
        var accountChanged = ['apiKey', 'apiServerUrl', 'cliPath'].some(function (key) { return e.affectsConfiguration('gcmp.devin.' + key); });
        if (accountChanged) {
          credCache = { value: null, at: 0 };
          provider.activeCredential = null;
          clearMetaState();
          prefixCache.clear();
          prefixOwners.clear();
          tokenCalibration.clear();
          estimateHistory.clear();
          devinQuotaState.last = null;
          devinQuotaRefresh(false);
        }
        if (accountChanged || e.affectsConfiguration('gcmp.devin.modelCatalog')) {
          catalogState = { at: 0, entries: [], byUid: {}, families: null, error: null, loading: null };
          rebuildModels(provider);
          provider.refreshCatalog(true).catch(function (err) { logErr('catalog refresh failed: ' + (err && err.message)); });
        }
        logLine('gcmp.devin configuration changed - relevant caches refreshed');
      }));
    } catch (e) { logLine('configuration change watcher not installed: ' + (e && e.message)); }
    if (context && context.subscriptions) { context.subscriptions.push.apply(context.subscriptions, disposables); }
    return disposables;
  }

  function installQuietly(context) {
    /* the load must happen even when install() short-circuits (a module-load fallback may have
       already registered the provider), otherwise the state file would fall back to %TEMP% */
    try { loadPrefixState(context); } catch (e) { logLine('prefix state load skipped: ' + (e && e.message)); }
    try { loadMetaState(); } catch (e) { logLine('meta state load skipped: ' + (e && e.message)); }
    try { install(context); } catch (e) { logErr('Devin provider install failed: ' + (e && e.message)); }
    try { installDevinQuotaItem(context, bridge.provider); } catch (e) { logErr('Devin quota status bar install failed: ' + (e && e.message)); }
    try { installPromptCacheWindow(context); } catch (e) { logErr('Devin prompt cache status bar install failed: ' + (e && e.message)); }
  }

  /* ===================== Devin plan / quota status bar =====================
   *
   * Mirrors what Devin Desktop shows in its usage panel:
   *   - plan name ("Max" / "Pro" / ...)
   *   - weekly quota remaining % (always shown)
   *   - daily quota remaining % (only when the plan exposes it, i.e. Pro)
   *   - reset timestamps for the two windows
   *
   * Backed by SeatManagementService.GetPlanStatus on server.codeium.com with
   * the desktop's session token in an `X-Auth-Token` header (NOT
   * Authorization: Basic and NOT X-Api-Key — those two are rejected with
   * 401 "missing auth token"). The response decodes the standard proto3
   * PlanStatus layout; we hand-parse the four fields we need.
   *
   * Plan rule (per user report):
   *   - Max  -> weekly window only
   *   - Pro  -> daily + weekly windows
   * We don't hard-code that; we just read both quota fields and display
   * whatever the server returned.
   */
  var DEVIN_QUOTA_REFRESH_MS = 5 * 60 * 1000;
  var DEVIN_QUOTA_ITEM_ID = 'gcmp.statusBar.devin';
  var DEVIN_QUOTA_REFRESH_CMD = 'gcmp.devin.refreshUsage';

  /* Hand-rolled minimal proto decoders for the PlanStatus envelope. */
  function quotaReadVarint(buf, i) {
    var shift = 0n, v = 0n;
    while (i < buf.length) {
      var b = buf[i++];
      v |= (BigInt(b & 0x7f) << shift);
      if (!(b & 0x80)) { return { value: v, next: i }; }
      shift += 7n;
    }
    return { value: v, next: i };
  }
  function quotaField(buf, wantField, wantWire) {
    var i = 0;
    while (i < buf.length) {
      var t = quotaReadVarint(buf, i); i = t.next;
      var wire = Number(t.value & 7n);
      var field = Number(t.value >> 3n);
      if (wire === 0) {
        var v = quotaReadVarint(buf, i); i = v.next;
        if (field === wantField && (wantWire === undefined || wantWire === 0)) { return { kind: 'varint', value: v.value }; }
      } else if (wire === 1) {
        var raw64 = buf.slice(i, i + 8); i += 8;
        if (field === wantField && (wantWire === undefined || wantWire === 1)) { return { kind: 'fixed64', value: raw64 }; }
      } else if (wire === 2) {
        var l = quotaReadVarint(buf, i); i = l.next;
        var rawLen = Number(l.value);
        var payload = buf.slice(i, i + rawLen); i += rawLen;
        if (field === wantField && (wantWire === undefined || wantWire === 2)) { return { kind: 'len', value: payload }; }
      } else if (wire === 5) {
        var raw32 = buf.slice(i, i + 4); i += 4;
        if (field === wantField && (wantWire === undefined || wantWire === 5)) { return { kind: 'fixed32', value: raw32 }; }
      } else {
        return null;
      }
    }
    return null;
  }
  function quotaFieldString(buf, wantField) {
    var f = quotaField(buf, wantField, 2);
    return f ? f.value.toString('utf8') : null;
  }
  function quotaFieldNumber(buf, wantField) {
    /* doubles are wire 1 fixed64; ints/varints are wire 0; percent counters here ride as
       plain integer varints (100, 98) even though the schema says T:5 (double) — handle both. */
    var f = quotaField(buf, wantField);
    if (!f) { return null; }
    if (f.kind === 'varint') { return Number(f.value); }
    if (f.kind === 'fixed64') { return f.value.readDoubleLE(0); }
    if (f.kind === 'fixed32') { return f.value.readFloatLE(0); }
    return null;
  }

  function decodePlanStatusResponse(buf) {
    /* PlanStatusResponse { field#1 plan_status (PlanStatus), field#2 team_used_prompt_credits (int64) } */
    if (!buf || !buf.length) { return null; }
    var psField = quotaField(buf, 1, 2);
    if (!psField) { return null; }
    var ps = psField.value;
    var out = {
      planName: null,
      hideDaily: false,
      hideWeekly: false,
      dailyRemaining: null,
      weeklyRemaining: null,
      dailyResetAtUnix: null,
      weeklyResetAtUnix: null,
      dailyResetAt: null,
      weeklyResetAt: null,
      overageBalanceMicros: null,
      acuConsumed: null,
      acuLimit: null,
      availablePromptCredits: null,
      usedPromptCredits: null,
    };
    var piField = quotaField(ps, 1, 2);
    if (piField) {
      var pi = piField.value;
      out.planName = quotaFieldString(pi, 2) || quotaFieldString(pi, 1) || out.planName;
      /* PlanInfo#36 hide_daily_quota / #37 hide_weekly_quota (bool varint) — the same flags
         Devin Desktop reads (`p?.planInfo?.hideDailyQuota===!0`) to decide which window to show.
         MAX plans set hideDaily=1; Pro / lower tiers leave both at 0. */
      var hd = quotaFieldNumber(pi, 36);
      var hw = quotaFieldNumber(pi, 37);
      out.hideDaily = (hd === 1);
      out.hideWeekly = (hw === 1);
    }
    out.dailyRemaining = quotaFieldNumber(ps, 14);
    out.weeklyRemaining = quotaFieldNumber(ps, 15);
    out.overageBalanceMicros = quotaFieldNumber(ps, 16);
    var dReset = quotaFieldNumber(ps, 17);
    var wReset = quotaFieldNumber(ps, 18);
    if (typeof dReset === 'number' && dReset > 0) { out.dailyResetAtUnix = dReset; out.dailyResetAt = new Date(dReset * 1000); }
    if (typeof wReset === 'number' && wReset > 0) { out.weeklyResetAtUnix = wReset; out.weeklyResetAt = new Date(wReset * 1000); }
    out.acuConsumed = quotaFieldNumber(ps, 19);
    out.acuLimit = quotaFieldNumber(ps, 20);
    /* prompt credit counters (field #6 used_prompt_credits, #8 available_prompt_credits) ride
       as varint int64; the schema declares sint64 so the encoder might zig-zag, but the
       observed stream uses plain varint — clamp to safe integer range. */
    var avail = quotaFieldNumber(ps, 8);
    if (typeof avail === 'number' && avail <= Number.MAX_SAFE_INTEGER) { out.availablePromptCredits = avail; }
    var used = quotaFieldNumber(ps, 6);
    if (typeof used === 'number' && used <= Number.MAX_SAFE_INTEGER) { out.usedPromptCredits = used; }
    return out;
  }

  var devinQuotaState = { timer: null, item: null, last: null, refreshInFlight: false };

  function devinQuotaSummaryText(q) {
    /* Display rule (matches Devin Desktop's `ex1/e.planInfo?.hideDailyQuota===!0` gate):
         - if hideDaily && hideWeekly  -> just plan name
         - if hideDaily                -> `N%` (weekly alone, MAX style)
         - if hideWeekly               -> `N%` (daily alone)
         - both visible                -> `100%(98%)`  (daily first, weekly in parens)
       We still honour the same percent values regardless of wire type because decode handles
       varint vs fixed64/fixed32. */
    if (!q) { return ''; }
    var hasD = !q.hideDaily && q.dailyRemaining !== null && q.dailyRemaining !== undefined && !Number.isNaN(q.dailyRemaining);
    var hasW = !q.hideWeekly && q.weeklyRemaining !== null && q.weeklyRemaining !== undefined && !Number.isNaN(q.weeklyRemaining);
    if (!hasD && !hasW) { return ''; }
    if (hasD && hasW) {
      return q.dailyRemaining + '%(' + q.weeklyRemaining + '%)';
    }
    var only = hasD ? q.dailyRemaining : q.weeklyRemaining;
    return only + '%';
  }

  function devinQuotaSummary(q) {
    if (!q) { return '$(gcmp-devin) ?'; }
    var summary = devinQuotaSummaryText(q);
    return '$(gcmp-devin)' + (summary ? (' ' + summary) : ' —');
  }

  function devinQuotaTooltip(q) {
    var md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    var plan = q.planName || 'Devin';
    md.appendMarkdown('**Devin ' + plan + '** — quota\n\n');
    md.appendMarkdown('| Window | Remaining | Reset in | Reset at |\n');
    md.appendMarkdown('| --- | ---: | --- | --- |\n');
    function fmtReset(ts) {
      if (!(ts instanceof Date) || isNaN(ts.getTime())) { return ['—', '—']; }
      var ms = ts.getTime() - Date.now();
      if (ms <= 0) { return ['soon', '—']; }
      var s = Math.floor(ms / 1000);
      var d = Math.floor(s / 86400);
      var h = Math.floor((s % 86400) / 3600);
      var m = Math.floor((s % 3600) / 60);
      var human = d > 0 ? (d + 'd ' + h + 'h') : (h > 0 ? (h + 'h ' + m + 'm') : (m + 'm'));
      var at = ts.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return [human, at];
    }
    if (!q.hideDaily && q.dailyRemaining !== null && q.dailyRemaining !== undefined && !Number.isNaN(q.dailyRemaining)) {
      var dr = fmtReset(q.dailyResetAt);
      md.appendMarkdown('| Daily | ' + q.dailyRemaining + '% | ' + dr[0] + ' | ' + dr[1] + ' |\n');
    }
    if (!q.hideWeekly && q.weeklyRemaining !== null && q.weeklyRemaining !== undefined && !Number.isNaN(q.weeklyRemaining)) {
      var wr = fmtReset(q.weeklyResetAt);
      md.appendMarkdown('| Weekly | ' + q.weeklyRemaining + '% | ' + wr[0] + ' | ' + wr[1] + ' |\n');
    }
    if (q.availablePromptCredits !== null && q.availablePromptCredits !== undefined) {
      md.appendMarkdown('\nAvailable prompt credits: `' + q.availablePromptCredits + '`\n');
    }
    if (q.acuConsumed !== null && q.acuConsumed !== undefined && q.acuLimit) {
      md.appendMarkdown('ACU: `' + q.acuConsumed + ' / ' + q.acuLimit + '`\n');
    }
    md.appendMarkdown('\n_Click to refresh._ Source: GCMP-Devin seat-management (X-Auth-Token).\n');
    return md;
  }

  function devinQuotaVisible() {
    return vscode.workspace.getConfiguration('gcmp.statusBar').get('devin', true) !== false;
  }

  function devinQuotaRefresh(force) {
    if (!devinQuotaVisible()) {
      if (devinQuotaState.item) { devinQuotaState.item.hide(); }
      return Promise.resolve();
    }
    if (!bridge.provider || typeof bridge.provider._devinRpc !== 'function') { return Promise.resolve(); }
    if (devinQuotaState.refreshInFlight) { return Promise.resolve(); }
    devinQuotaState.refreshInFlight = true;
    var candidates = bridge.provider._devinCredentialCandidates ? bridge.provider._devinCredentialCandidates() : [];
    if (!candidates.length) {
      devinQuotaState.refreshInFlight = false;
      if (devinQuotaState.item) { devinQuotaState.item.hide(); }
      return Promise.resolve();
    }
    var c = candidates[0];
    var payload = (function () { /* include_top_up_status:true = field #2 varint 1 */
      function varintOf(v) { var b = []; var x = v; do { var byte = x & 0x7f; x = (x / 128) | 0; if (x) byte |= 0x80; b.push(byte); } while (x); return Buffer.from(b); }
      var tag = varintOf((2 << 3) | 0);
      var val = varintOf(1);
      return Buffer.concat([tag, val]);
    })();
    return bridge.provider._devinRpc('GetPlanStatus', payload, { 'X-Auth-Token': c.apiKey })
      .then(function (buf) {
        devinQuotaState.refreshInFlight = false;
        var q = decodePlanStatusResponse(buf);
        if (!q) { throw new Error('unexpected GetPlanStatus payload'); }
        devinQuotaState.last = { quota: q, at: Date.now() };
        if (devinQuotaState.item) {
          devinQuotaState.item.text = devinQuotaSummary(q);
          devinQuotaState.item.tooltip = devinQuotaTooltip(q);
          if (devinQuotaVisible()) { devinQuotaState.item.show(); } else { devinQuotaState.item.hide(); }
        }
        logLine('devin quota: plan=' + (q.planName || '?') + ' daily=' + (q.dailyRemaining !== null ? q.dailyRemaining + '%' : 'n/a') + ' weekly=' + (q.weeklyRemaining !== null ? q.weeklyRemaining + '%' : 'n/a'));
      })
      .catch(function (e) {
        devinQuotaState.refreshInFlight = false;
        if (devinQuotaState.item) {
          devinQuotaState.item.text = '$(gcmp-devin) !';
          var md = new vscode.MarkdownString('Devin quota fetch failed\n\n`' + (e && e.message).slice(0, 200) + '`\n\n_Click to retry._');
          md.isTrusted = true;
          devinQuotaState.item.tooltip = md;
          if (devinQuotaVisible()) { devinQuotaState.item.show(); } else { devinQuotaState.item.hide(); }
        }
        logErr('devin quota fetch failed: ' + (e && e.message));
      });
  }

  function installDevinQuotaItem(context, provider) {
    if (!vscode.window || typeof vscode.window.createStatusBarItem !== 'function') { return; }
    if (devinQuotaState.item) { return; }
    var item = vscode.window.createStatusBarItem(DEVIN_QUOTA_ITEM_ID, vscode.StatusBarAlignment.Right, 13);
    item.name = 'GCMP: Devin Usage';
    item.text = '$(gcmp-devin) —';
    item.command = DEVIN_QUOTA_REFRESH_CMD;
    var md = new vscode.MarkdownString('Click to fetch the Devin plan quota.\n');
    md.isTrusted = true;
    item.tooltip = md;
    item.show();
    if (context && context.subscriptions) { context.subscriptions.push(item); }
    devinQuotaState.item = item;
    /* Command registration is separate from the item so the click keeps working across reloads. */
    try {
      var cmd = vscode.commands.registerCommand(DEVIN_QUOTA_REFRESH_CMD, function () { devinQuotaRefresh(true); });
      if (context && context.subscriptions) { context.subscriptions.push(cmd); }
    } catch (e) { logErr('devin refresh command registration failed: ' + (e && e.message)); }
    /* One immediate fetch + then poll every 5 min. */
    devinQuotaRefresh(false);
    if (devinQuotaState.timer) { clearInterval(devinQuotaState.timer); }
    devinQuotaState.timer = setInterval(function () { devinQuotaRefresh(false); }, DEVIN_QUOTA_REFRESH_MS);
    if (devinQuotaState.timer && typeof devinQuotaState.timer.unref === 'function') { devinQuotaState.timer.unref(); }
  }

  // Exposed for live probes.
  var devinQuota = {
    refresh: devinQuotaRefresh,
    decode: decodePlanStatusResponse,
    state: devinQuotaState,
  };
  globalThis.__gcmpDevinBridge.quota = devinQuota;

  // Source-level integration: export a real installer so the host activation can register the
  // Devin provider with a genuine ExtensionContext (the minified-bundle activate hook is gone).
  module.exports = {
    installDevinProvider: function (context) { installQuietly(context); },
  };
})();
