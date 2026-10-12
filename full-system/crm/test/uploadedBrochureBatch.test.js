'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function setup(rows, fail = false) {
  let db = { BuilderProjects: structuredClone(rows) }, calls = 0;
  const repo = { read: () => structuredClone(db), write: value => { db = structuredClone(value); }, list: key => structuredClone(db[key] || []) };
  const projects = { get: id => ({ ok: true, data: structuredClone(db.BuilderProjects.find(p => p.ProjectID === id)) }),
    update: (id, payload, mutateDb) => { const p = db.BuilderProjects.find(p => p.ProjectID === id); Object.assign(p,payload); if (mutateDb) mutateDb(db); return { ok:true,data:p }; } };
  const ctx = { module: { exports: {} }, Buffer, structuredClone, Set, Map, Date, require: name => {
    if (name === 'node:crypto') return require(name);
    if (name.endsWith('builderProjectService')) return { BuilderProjectService: class {} };
    if (name.endsWith('projectMediaCanaryMigrationService')) return { ProjectMediaCanaryMigrationService: class {} };
    if (name.endsWith('brochureExtractionService')) return { extractBrochure() {} };
    if (name.endsWith('brochurePdfPreparationService')) return { preparePdfForAi:async buffer=>({buffer,optimized:false}) };
    if (name.endsWith('brochureCompletenessService')) return { REVIEW_VERSION:'full-page-review-v1' };
    if (name.endsWith('mongoStore')) return { isEnabled: () => false };
    throw Error(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/services/uploadedBrochureBatchService.js'),'utf8'),ctx);
  const api = ctx.module.exports;
  const svc = new api.UploadedBrochureBatchService(repo,{ projects, visible:p=>p.CompanyID === 'mine',
    media: { getProjectBrochureFile: async (_id, mediaId, key) => { assert.ok(mediaId); assert.ok(key); return { ok:true,buffer:Buffer.from('%PDF test') }; } },
    extract: async () => { calls++; if (fail) throw Error('AI unavailable'); return { CompletenessReview:{Version:'full-page-review-v1',Status:'automated_checks_passed',PageCount:2}, ProjectName:'Coral Heights', BuilderName:'Swagat Developers', ConfigDetails:[], Amenities:['Gym'], Highlights:['Good tiles'], SourceEvidence:[], ReadingWarnings:['Carpet not printed'] }; } });
  return { ...api, svc, repo, calls:()=>calls };
}
const pdf = id => ({ MediaID:id,DriveFileID:id,verified:true,downloadStatus:'downloaded',Filename:id+'.pdf' });
const project = { ProjectID:'p1',ProjectName:'Coral Heights',CompanyID:'mine',UpdatedAt:'before',Amenities:['Garden'],Highlights:['Manual specification'],Brochures:[pdf('one'),pdf('one'),pdf('two')] };
test('queue covers all distinct stored PDFs, excludes other tenants and remote-only URLs; actor isolation and idempotent steps',async()=>{
  const x=setup([project,{...project,ProjectID:'hidden',CompanyID:'other'},{...project,ProjectID:'url',Brochures:[{Url:'https://example.com/a.pdf'}]}]);
  const start=x.svc.start('user'); assert.equal(start.data.Total,2); assert.equal(start.data.WithoutStoredBrochure,1);
  assert.equal(x.svc.start('user').data.JobID,start.data.JobID);
  assert.equal(x.svc.latest('other').data,null);
  assert.equal((await x.svc.step(start.data.JobID,'other')).statusCode,404);
  let out=await x.svc.step(start.data.JobID,'user'); assert.equal(out.data.Saved,1); assert.equal(out.data.Pending,1);
  out=await x.svc.step(start.data.JobID,'user'); assert.equal(out.data.Saved,2); assert.equal(out.data.Status,'complete');
  await x.svc.step(start.data.JobID,'user'); assert.equal(x.calls(),2);
  assert.deepEqual(x.repo.read().BuilderProjects[0].Amenities,['Gym']);
  assert.deepEqual(x.repo.read().BuilderProjects[0].Highlights,['Good tiles']);
});
test('AI failures are logged; following PDF remains queued and no project fields are changed',async()=>{
  const x=setup([project],true); const j=x.svc.start('user').data; const out=await x.svc.step(j.JobID,'user');
  assert.equal(out.data.Failed,1); assert.equal(out.data.Pending,1); assert.equal(out.data.Items[0].Error,'AI unavailable');
  assert.equal(x.repo.read().BuilderProjects[0].BuilderName,undefined);
});
test('draft survives save failure so retry does not repeat paid extraction',async()=>{
  const x=setup([project]); const j=x.svc.start('user').data; const original=x.svc.projects.update;
  x.svc.projects.update=()=>({ok:false,error:'Save failed'});
  await x.svc.step(j.JobID,'user'); assert.equal(x.calls(),1);
  assert.equal(x.svc.retry(j.JobID,'other').statusCode,404);
  assert.equal(x.svc.retry(j.JobID,'user').data.Failed,0); x.svc.projects.update=original;
  await x.svc.step(j.JobID,'user'); assert.equal(x.calls(),1);
});
test('identity mismatch is blocked; areas require printed page and label evidence; landline retained in notes',()=>{
  const x=setup([]);
  assert.throws(()=>x.buildPayload(project,{ProjectName:'Another project'}),/does not match/);
  const result=x.buildPayload(project,{ProjectName:'Coral Heights',SalesPersonPhone:'0261-2912060',SourceEvidence:['Page 12 Carpet area 995 sqft','Page 12 Saleable area 1809 sqft'],ConfigDetails:[{Type:'Apartment',BHK:3,CarpetAreaSqft:995,SuperBuiltUpAreaSqft:1809,TerraceAreaSqft:200}]});
  assert.equal(result.ConfigDetails[0].CarpetAreaSqft,995); assert.equal(result.ConfigDetails[0].SuperBuiltUpAreaSqft,1809); assert.equal(result.ConfigDetails[0].TerraceAreaSqft,null);
  assert.equal(result.SalesPersonPhone,undefined); assert.match(result.Notes,/0261-2912060/);
});
test('batch UI and server compile; update permission and tenant check protect all operations',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../builder-projects.html'),'utf8');
  for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'); new vm.Script(server);
  assert.match(server,/UploadedBrochureBatchService/); assert.match(server,/visible: row => tenantCheck\(row, actor\)\.ok/);
  assert.match(html,/uploadedBatch\.Pending > 0/); assert.match(html,/Pause after current PDF/);
});
test('real project update commits fields and queue metadata in one snapshot and clears stale developer ID',()=>{
  let db={BuilderProjects:[{...structuredClone(project),BuilderName:'Old builder',BuilderID:'old',Location1:'Vesu'}],Builders:[{BuilderID:'old',BuilderName:'Old builder'}]}, writes=0;
  const repo={read:()=>structuredClone(db),list:key=>structuredClone(db[key]||[]),write:value=>{writes++;db=structuredClone(value)}};
  const context={module:{exports:{}},require:name=>name==='node:crypto'?require(name):{},Buffer,URL};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/services/builderProjectService.js'),'utf8'),context);
  const svc=new context.module.exports.BuilderProjectService(repo);
  const result=svc.update('p1',{BuilderID:null,BuilderName:'Printed developer',ConfigDetails:[{Type:'Apartment',CarpetAreaSqft:995}]},snapshot=>{
    snapshot.UploadedBrochureBatches=[{JobID:'job',Items:[{ItemID:'pdf',Status:'saved'}]}];
  });
  assert.equal(result.ok,true);assert.equal(writes,1);assert.equal(db.BuilderProjects[0].BuilderName,'Printed developer');
  assert.equal(db.BuilderProjects[0].ConfigDetails[0].CarpetAreaSqft,995);assert.equal(db.UploadedBrochureBatches[0].Items[0].Status,'saved');
});

test('project-name prefixes cannot authorize importing a different phase',()=>{
 const x=setup([]);
 assert.throws(()=>x.buildPayload({...project,ProjectName:'Coral Heights'},{ProjectName:'Coral Heights II'}),/does not match/);
});
test('transient AI failure pauses queue durably and resume cannot bypass provider cooldown',async()=>{
 const x=setup([project]);let now=1000000000000,calls=0;x.svc.now=()=>now;
 x.svc.extract=async()=>{calls++;const e=new Error('High demand');e.status=503;e.code='AI_UNAVAILABLE';e.retryAfterSeconds=120;throw e;};
 const j=x.svc.start('user').data;
 const out=await x.svc.step(j.JobID,'user');
 assert.equal(out.data.Status,'cooldown');assert.equal(out.data.Failed,0);assert.equal(out.data.Pending,2);
 assert.equal(Date.parse(out.data.NextRetryAt),now+120000);
 assert.equal(out.data.Items[0].Attempts,1);assert.equal(out.data.Items[1].Attempts,0);
 await x.svc.step(j.JobID,'user');assert.equal(calls,1);
 assert.equal(x.svc.retry(j.JobID,'user').statusCode,409);
 assert.equal(x.svc.latest('user').data.Status,'cooldown');
 now+=120001;await x.svc.step(j.JobID,'user');assert.equal(calls,2);
 assert.equal(x.repo.read().BuilderProjects[0].BuilderName,undefined);
});
test('transient retries stop after three attempts without cascading through other PDFs',async()=>{
 const x=setup([project]);let now=1000000000000,calls=0;x.svc.now=()=>now;
 x.svc.extract=async()=>{calls++;const e=new Error('Quota exceeded');e.status=429;throw e;};
 const j=x.svc.start('user').data;
 for(let i=0;i<3;i++){const out=await x.svc.step(j.JobID,'user');now=Date.parse(out.data.NextRetryAt)+1;}
 const job=x.svc.latest('user').data;
 assert.equal(calls,3);assert.equal(job.Items[0].Status,'failed');assert.equal(job.Items[0].Attempts,3);
 assert.equal(job.Items[1].Attempts,0);assert.equal(job.Status,'cooldown');
});
