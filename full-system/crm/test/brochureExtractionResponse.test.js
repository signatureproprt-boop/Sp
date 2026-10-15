'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { __test } = require('../server');
const mongoStore = require('../src/data/mongoStore');

function testExtraction() {
 const ctx = {module:{exports:{}},Buffer,process,AbortSignal,structuredClone,fetch:(...args)=>global.fetch(...args),require:name=>name==='./brochureCompletenessService'?{...require('../src/services/brochureCompletenessService'),countPdfPages:async()=>1}:require(name)};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/services/brochureExtractionService'),'utf8'),ctx);return ctx.module.exports;
}
const emptyReview = {Complete:true,Pages:[{Page:1,Kind:'other',HasConfigurations:false}],ConfigChecks:[],Findings:[]};

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
    vm.runInNewContext(source.slice(start, end), { res, actor: { userId: 'test-user' }, body: { fileBase64: 'cGRm' },
      sendJson: __test.sendJson, require: () => ({ extractBrochure: async () => ({ ProjectName: 'Milestone Utsav' }) }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).data.ProjectName, 'Milestone Utsav');
    assert.equal(flushes, 0);
  } finally { mongoStore.isEnabled = enabled; mongoStore.isInitialized = initialized; }
});

test('individual and bulk PDF extraction report upstream text errors without a JSON parse crash', async () => {
  const html = fs.readFileSync(require.resolve('../builder-projects.html'), 'utf8');
  const start = html.indexOf('  const brochureReaderCooldowns =');
  const end = html.indexOf('  async function onBrochureAutoFill(', start);
  const context = { AbortController, setTimeout, clearTimeout, atob, crypto: require('node:crypto').webcrypto, editingId: 'test', brochureCache: async () => null,
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
      if (prompt.startsWith('Independently audit')) return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(emptyReview)}]}}]})};
      for (const field of ['ProjectArea', 'TotalTowers', 'TotalFloors', 'FloorHeightFt', 'Overview']) {
        assert.ok(prompt.includes('"' + field + '"'), field + ' must be requested');
      }
      assert.match(prompt, /S\.A\. .*SuperBuiltUpAreaSqft/);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
        { thought: true, text: 'Internal reasoning' },
        { text: '{"ProjectName":"Milestone Utsav","TotalUnits":48}' }
      ] } }] }) };
    };
    const result = await testExtraction().extractBrochure(Buffer.from('%PDF sample').toString('base64'));
    assert.equal(result.ProjectName, 'Milestone Utsav');
    assert.equal(result.TotalUnits, 48);
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
  }
});

test('rendered PDF uses page text and JPEG instead of the heavy original', async () => {
  const oldFetch = global.fetch, oldKey = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = async (_url, options) => {
      const parts = JSON.parse(options.body).contents[0].parts;
      if(parts[0].text.startsWith('Independently audit')) return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(emptyReview)}]}}]})};
      assert.match(parts[1].text, /Page 1 text: BLDG A.*1-14/);
      assert.equal(parts[2].inline_data.mime_type, 'image/jpeg');
      assert.equal(parts.some(p => p.inline_data?.mime_type === 'application/pdf'), false);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{text:'{"TotalTowers":2,"TotalFloors":14}'}] } }] }) };
    };
    const service = testExtraction();
    const result = await service.extractBrochure(Buffer.from('%PDF original').toString('base64'),
      [{data:Buffer.from([255,216,255,217]).toString('base64'),text:'BLDG A typical floor LVL 1-14'}]);
    assert.equal(result.TotalFloors,14);
    await assert.rejects(service.extractBrochure('cGRm', [{data:'cGRm'}]), /Invalid rendered PDF pages/);
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
  }
});

test('manual reader respects provider cooldown and retains a retryable failure',async()=>{
 const html=fs.readFileSync(require.resolve('../builder-projects.html'),'utf8');
 const start=html.indexOf('  const brochureReaderCooldowns ='),end=html.indexOf('  async function onBrochureAutoFill(',start);
 let calls=0;
 const context={AbortController,setTimeout,clearTimeout,atob,crypto:require('node:crypto').webcrypto,editingId:'cooldown-test',brochureCache:async()=>null,
 fetch:async()=>{calls++;return {ok:false,status:503,text:async()=>JSON.stringify({ok:false,retryAfterSeconds:120})};}};
 vm.createContext(context);vm.runInContext(html.slice(start,end),context);
 await assert.rejects(context.requestBrochureExtraction('x.pdf','cGRm'),/Retry after 120 seconds/);
 await assert.rejects(context.requestBrochureExtraction('x.pdf','cGRm'),/AI busy/);assert.equal(calls,1);
});
