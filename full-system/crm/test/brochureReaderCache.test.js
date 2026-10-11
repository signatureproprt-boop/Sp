'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('same PDF shares one extraction; failed attempts are retryable and scopes stay separate', async () => {
  let calls = 0;
  let fail = false;
  const data = { ProjectName: 'Test', Amenities: ['Gym'], Highlights: [], ConfigDetails: [] };
  const context = { module: { exports: {} }, require, process: { env: { GEMINI_API_KEY: 'test' } },
    Buffer, AbortSignal, structuredClone,
    fetch: async (_url, options) => { calls++;
      const request = JSON.parse(options.body);
      assert.equal(request.contents[0].parts[1].inline_data.mime_type, 'application/pdf');
      await new Promise(resolve => setImmediate(resolve));
      return { ok: !fail, status: 500, json: async () => fail ? { error: { message: 'temporary failure' } } :
        { candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }] } }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/brochureExtractionService.js'), 'utf8'), context);
  const extract = context.module.exports.extractBrochure;
  const pdf = Buffer.from('%PDF test').toString('base64');
  const [a, b] = await Promise.all([extract(pdf, null, 'one'), extract(pdf, null, 'one')]);
  assert.equal(calls, 1);
  a.Amenities.push('mutation');
  assert.deepEqual(b.Amenities, ['Gym']);
  await extract(pdf, null, 'one'); assert.equal(calls, 1);
  await extract(pdf, null, 'two'); assert.equal(calls, 2);
  fail = true;
  await assert.rejects(extract(pdf, null, 'three'), /temporary failure/);
  fail = false;
  await extract(pdf, null, 'three'); assert.equal(calls, 4);
});

test('brochure form compiles and BHK-only extracted configurations survive save filtering', () => {
  const html = fs.readFileSync(path.join(__dirname, '../builder-projects.html'), 'utf8');
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  const start = html.indexOf('  function applyAutoFill(d)');
  const end = html.indexOf('  function closeProjectModal', start);
  const fields = {};
  const context = { document: { getElementById: id => fields[id] || (fields[id] = { value: '' }) }, configRows: [], renderConfigRowsUI() {} };
  vm.createContext(context); vm.runInContext(html.slice(start, end), context);
  context.applyAutoFill({ ConfigDetails: [{ BHK: 3, CarpetAreaSqft: 900, ParkingAllotted: 2, ServantRoom: true }] });
  assert.equal(context.configRows[0].Type, '3 BHK');
  assert.equal(context.configRows[0].ParkingAllotted, 2);
  assert.equal(context.configRows[0].ServantRoom, true);
  assert.ok(html.includes('Read uploaded brochure'));
  assert.ok(html.includes('existing values retained'));
});

test('response body timeout reports service delay and remains retryable', async () => {
  let fail = true;
  let timeoutMs;
  const context = { module: { exports: {} }, require, process: { env: { GEMINI_API_KEY: 'test' } },
    Buffer, structuredClone, AbortSignal: { timeout: ms => { timeoutMs = ms; return {}; } },
    fetch: async () => ({ ok: true, json: async () => {
      if (fail) throw Object.assign(new Error('body timeout'), { name: 'TimeoutError' });
      return { candidates: [{ content: { parts: [{ text: '{"ProjectName":"Test"}' }] } }] };
    } }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/brochureExtractionService.js'), 'utf8'), context);
  const pdf = Buffer.from('%PDF timeout').toString('base64');
  await assert.rejects(context.module.exports.extractBrochure(pdf), /AI service did not finish within 4 minutes/);
  assert.equal(timeoutMs, 240000);
  fail = false;
  assert.equal((await context.module.exports.extractBrochure(pdf)).ProjectName, 'Test');
});


test('regular, penthouse and terrace configurations retain separate private areas through form rendering', () => {
  const html = fs.readFileSync(path.join(__dirname, '../builder-projects.html'), 'utf8');
  const fields = {};
  const context = { document: { getElementById: id => fields[id] || (fields[id] = { value: '', innerHTML: '' }) }, configRows: [], esc: String };
  vm.createContext(context);
  let start = html.indexOf('  function applyAutoFill(d)');
  vm.runInContext(html.slice(start, html.indexOf('  function closeProjectModal', start)), context);
  start = html.indexOf('  function renderConfigRowsUI()');
  vm.runInContext(html.slice(start, html.indexOf('  // ── Auto-fill', start)), context);
  context.applyAutoFill({ ConfigDetails: [
    { Tower: 'A', FlatType: '1', Type: 'Apartment', BHK: 3, CarpetAreaSqft: 900, SuperBuiltUpAreaSqft: 1500, TerraceAreaSqft: null },
    { Tower: 'A', FlatType: '1', Type: 'Penthouse', BHK: 4, CarpetAreaSqft: 1800, SuperBuiltUpAreaSqft: 3000, TerraceAreaSqft: 600, ParkingAllotted: 0, ServantRoom: false },
    { Tower: 'A', FlatType: '1', Type: 'Terrace Flat', BHK: 3, CarpetAreaSqft: 900, SuperBuiltUpAreaSqft: 1500, TerraceAreaSqft: 250 }
  ] });
  assert.equal(context.configRows.length, 3);
  assert.equal(context.configRows[1].Type, 'Penthouse');
  assert.equal(context.configRows[1].CarpetAreaSqft, 1800);
  assert.equal(context.configRows[1].SuperBuiltUpAreaSqft, 3000);
  assert.equal(context.configRows[1].TerraceAreaSqft, 600);
  assert.equal(context.configRows[1].ParkingAllotted, 0);
  assert.equal(context.configRows[1].ServantRoom, false);
  assert.equal(context.configRows[0].TerraceAreaSqft, '');
  assert.match(fields['config-rows'].innerHTML, /config-terrace-1/);
  assert.match(fields['config-rows'].innerHTML, /Private terrace area sqft/);
  assert.match(fields['config-rows'].innerHTML, /value="600"/);
});
