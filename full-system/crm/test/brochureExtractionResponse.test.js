'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { __test } = require('../server');
const mongoStore = require('../src/data/mongoStore');

test('PDF preview returns fields without waiting for a stuck snapshot save', async () => {
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  const start = source.indexOf("        // Extraction only previews fields;");
  const end = source.indexOf('\n        return;', start);
  const enabled = mongoStore.isEnabled, initialized = mongoStore.isInitialized;
  let flushes = 0;
  const res = { __sigRequireMongoDurability: true,
    writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  try {
    mongoStore.isEnabled = () => true; mongoStore.isInitialized = () => true;
    __test.setRuntimeForTest({ repository: { flush() { flushes++; return new Promise(() => {}); } } });
    vm.runInNewContext(source.slice(start, end), { res, body: { fileBase64: 'cGRm' },
      sendJson: __test.sendJson, require: () => ({ extractBrochure: async () => ({ ProjectName: 'Milestone Utsav' }) }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).data.ProjectName, 'Milestone Utsav');
    assert.equal(flushes, 0);
  } finally { mongoStore.isEnabled = enabled; mongoStore.isInitialized = initialized; }
});

test('individual and bulk PDF extraction report upstream text errors without a JSON parse crash', async () => {
  const html = fs.readFileSync(require.resolve('../builder-projects.html'), 'utf8');
  const start = html.indexOf('  async function requestBrochureExtraction(');
  const end = html.indexOf('  async function onBrochureAutoFill(', start);
  const context = { AbortController, setTimeout, clearTimeout,
    fetch: async () => ({ ok: false, status: 502, text: async () => 'upstream request timeout' }) };
  vm.createContext(context); vm.runInContext(html.slice(start, end), context);
  await assert.rejects(context.requestBrochureExtraction('brochure.pdf', 'cGRm'), /HTTP 502/);
  context.fetch = async () => ({ ok: true, status: 200, text: async () => '{"ok":true,"data":{"ProjectName":"Milestone"}}' });
  assert.equal((await context.requestBrochureExtraction('brochure.pdf', 'cGRm')).data.ProjectName, 'Milestone');
  assert.match(html, /requestBrochureExtraction\(bulkBrochureFiles\[i\].file.name, fileBase64\)/);
});

test('Gemini PDF extraction uses low reasoning and reads only final JSON fields', async () => {
  const oldFetch = global.fetch, oldKey = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.equal(body.contents[0].parts[1].inline_data.mime_type, 'application/pdf');
      assert.ok(options.signal);
      const prompt = body.contents[0].parts[0].text;
      for (const field of ['ProjectArea', 'TotalTowers', 'TotalFloors', 'FloorHeightFt', 'Overview']) {
        assert.ok(prompt.includes('"' + field + '"'), field + ' must be requested');
      }
      assert.match(prompt, /do NOT treat S\.A\./);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
        { thought: true, text: 'Internal reasoning' },
        { text: '{"ProjectName":"Milestone Utsav","TotalUnits":48}' }
      ] } }] }) };
    };
    const result = await require('../src/services/brochureExtractionService').extractBrochure(Buffer.from('%PDF sample').toString('base64'));
    assert.equal(result.ProjectName, 'Milestone Utsav');
    assert.equal(result.TotalUnits, 48);
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
  }
});
