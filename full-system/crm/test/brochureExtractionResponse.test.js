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
