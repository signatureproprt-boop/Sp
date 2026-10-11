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

test('project persistence keeps private terrace separate and preserves each unit type', () => {
  const context = { module: { exports: {} }, require: id => {
    if (id === 'csv-parse/sync') return { parse() {} };
    if (id === 'read-excel-file/node') return () => {};
    if (id.startsWith('./')) return {};
    return require(id);
  }, process, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/builderProjectService.js'), 'utf8'), context);
  const service = new context.module.exports.BuilderProjectService({});
  const rows = ['Apartment', 'Penthouse', 'Terrace Flat'].map((Type, i) => ({
    Tower: 'A', FlatType: '1', Type, BHK: 3, CarpetAreaSqft: '900',
    SuperBuiltUpAreaSqft: '1500', TerraceAreaSqft: i ? String(i * 250) : null,
    ParkingAllotted: 0, ServantRoom: false
  }));
  const saved = service._normalizePayload({ ConfigDetails: rows });
  const reloaded = service._normalizePayload(saved);
  assert.equal(reloaded.ConfigDetails.length, 3);
  assert.equal(reloaded.ConfigDetails[1].Type, 'Penthouse');
  assert.equal(reloaded.ConfigDetails[1].TerraceAreaSqft, 250);
  assert.equal(reloaded.ConfigDetails[2].TerraceAreaSqft, 500);
  for (const row of reloaded.ConfigDetails) {
    assert.equal(row.CarpetAreaSqft, 900);
    assert.equal(row.SuperBuiltUpAreaSqft, 1500);
    assert.equal(row.ParkingAllotted, 0);
    assert.equal(row.ServantRoom, false);
  }
  assert.equal(reloaded.ConfigDetails[0].TerraceAreaSqft, null);
});

test('display groups identical tower configurations without changing saved rows', () => {
  const html = fs.readFileSync(path.join(__dirname, '../builder-projects.html'), 'utf8');
  const start = html.indexOf('  function groupedConfigDetails(rows)');
  const context = {}; vm.createContext(context);
  vm.runInContext(html.slice(start, html.indexOf('  function renderCard(p)', start)), context);
  const base = { Type: 'Apartment', BHK: 3, CarpetAreaSqft: 1500, SuperBuiltUpAreaSqft: 2500, ParkingAllotted: 2, ServantRoom: false };
  const rows = [
    { ...base, Tower: 'A', FlatType: '1' }, { ...base, Tower: 'B', FlatType: '1' },
    { ...base, Tower: 'C', FlatType: '2' }, { ...base, Tower: 'D', CarpetAreaSqft: 1600 },
    { ...base, Tower: 'A', Type: 'Penthouse', TerraceAreaSqft: 500 },
    { ...base, Tower: 'B', Type: 'Terrace Flat', TerraceAreaSqft: 300 },
    { ...base, Tower: 'E', ParkingAllotted: null }
  ];
  const before = JSON.stringify(rows);
  const groups = context.groupedConfigDetails(rows);
  assert.equal(groups.length, 5);
  assert.equal(groups[0].Tower, 'A/B/C');
  assert.equal(groups[0].FlatType, '1/2');
  assert.equal(groups[0].CarpetAreaSqft, 1500);
  assert.equal(groups[0].SuperBuiltUpAreaSqft, 2500);
  assert.equal(groups[2].Type, 'Penthouse');
  assert.equal(groups[3].Type, 'Terrace Flat');
  assert.equal(JSON.stringify(rows), before);
  assert.equal((html.match(/groupedConfigDetails\(p.ConfigDetails\)/g) || []).length, 2);
});

test('brochure catalogue groups edit rows and keeps layout evidence and missing-area reasons', () => {
  const html = fs.readFileSync(path.join(__dirname, '../builder-projects.html'), 'utf8');
  const fields = {};
  const context = { document: { getElementById: id => fields[id] || (fields[id] = { value: '' }) }, configRows: [], renderConfigRowsUI() {} };
  vm.createContext(context);
  let start = html.indexOf('  function groupedConfigDetails(rows)');
  vm.runInContext(html.slice(start, html.indexOf('  function renderCard(p)', start)), context);
  start = html.indexOf('  function applyAutoFill(d)');
  vm.runInContext(html.slice(start, html.indexOf('  function closeProjectModal', start)), context);
  context.applyAutoFill({ BuilderName: 'Swagat Developers', SourceEvidence: ['Page 5: Swagat Developers'], ReadingWarnings: ['Total carpet area not stated on page 12.'],
    ConfigDetails: [
      { Tower: 'A', FlatType: '101', Type: 'Apartment', BHK: 3 },
      { Tower: 'B', FlatType: '105', Type: 'Apartment', BHK: 3 },
      { Tower: 'C', FlatType: 'Layout upper', Type: 'Apartment', BHK: 3 },
      { Tower: 'C', FlatType: 'Layout lower', Type: 'Apartment', BHK: 3 }
    ] });
  assert.equal(context.configRows.length, 3);
  assert.equal(context.configRows[0].Tower, 'A/B');
  assert.equal(context.configRows[0].CarpetAreaSqft, '');
  assert.equal(fields['f-builder-name'].value, 'Swagat Developers');
  assert.match(fields['f-notes'].value, /Page 5/);
  assert.match(fields['f-notes'].value, /not stated/);
  const service = fs.readFileSync(path.join(__dirname, '../src/services/brochureExtractionService.js'), 'utf8');
  assert.match(service, /Do NOT expand site-plan flat numbers/);
  assert.match(service, /For every numeric area provide a SourceEvidence/);
  assert.doesNotMatch(service, /separate configuration for EVERY tower/);
});
