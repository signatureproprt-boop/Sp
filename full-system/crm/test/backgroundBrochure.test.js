'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {BackgroundBrochureService, fillMissing} = require('../src/services/backgroundBrochureService');
const {REVIEW_VERSION} = require('../src/services/brochureCompletenessService');
const actor = {companyId:'c',brokerageId:'b',userId:'admin'};
const pdf = id => ({MediaID:id,DriveFileID:id,verified:true,downloadStatus:'downloaded'});
const project = {ProjectID:'p',ProjectName:'Coral Heights',CompanyID:'c',BrokerageID:'b',Category:'Residential',UpdatedAt:'initial',Brochures:[pdf('one')]};
function setup(rows=[project]) {
  let db = {BuilderProjects:structuredClone(rows),Users:[{UserID:'admin',CompanyID:'c',BrokerageID:'b',Role:'ADMIN',Status:'ACTIVE'}]};
  const repo={read:()=>structuredClone(db),write:value=>{db=structuredClone(value);},list:key=>structuredClone(db[key]||[])};
  let calls=0,flushes=0,now=Date.now();
  const deps={now:()=>now,flush:async()=>{flushes++;},lock:async(_name,fn)=>({acquired:true,result:await fn()}),
    projects:{get:id=>({ok:true,data:repo.list('BuilderProjects').find(p=>p.ProjectID===id)}),update:(id,payload,mutate)=>{
      const next=repo.read();Object.assign(next.BuilderProjects.find(p=>p.ProjectID===id),payload);mutate(next);repo.write(next);return {ok:true};}},
    media:{getProjectBrochureFile:async()=>({ok:true,buffer:Buffer.from('%PDF fixture')})},prepare:async buffer=>({buffer}),
    extract:async(_file,_prompt,_actor,options)=>{calls++;await options.onCheckpoint({Stage:'checked'});return {ProjectName:'Coral Heights',BuilderName:'Printed developer',Amenities:['Gym'],Highlights:[],SourceEvidence:['Page 2: developer Printed developer'],CompletenessReview:{Version:REVIEW_VERSION,Status:'automated_checks_passed'}};}};
  const service=new BackgroundBrochureService(repo,deps);
  service.setEnabled(actor,true);
  const id=service.get(actor).AutomationID;
  return {repo,deps,service,id,calls:()=>calls,flushes:()=>flushes,advance:ms=>{now+=ms;}};
}
test('background worker selects only tenant Residential stored PDFs and survives a new service instance without rereading',async()=>{
  const x=setup([project,{...project,ProjectID:'foreign',CompanyID:'other'},{...project,ProjectID:'commercial',Category:'Commercial'},{...project,ProjectID:'missing',Brochures:[]}]);
  assert.equal((await x.service.tick(x.id)).state,'processed');assert.equal(x.calls(),1);assert.ok(x.flushes()>=4);
  const status=x.service.status(actor).data;assert.equal(status.Batch.Total,1);assert.equal(status.Batch.WithoutStoredBrochure,1);
  assert.equal(status.Batch.Saved,1);assert.equal(status.Batch.Items[0].Checkpoint,undefined);
  const restarted=new BackgroundBrochureService(x.repo,x.deps);assert.equal((await restarted.tick(x.id)).state,'complete');assert.equal(x.calls(),1);
  assert.equal(x.repo.list('BuilderProjects')[0].BuilderName,'Printed developer');
  assert.equal(x.service.status({...actor,companyId:'other'}).data,null);
});
test('provider cooldown is durable across restarts and does not repeat calls before retry',async()=>{
  const x=setup();let attempts=0;x.deps.extract=async()=>{attempts++;const e=Error('Quota exceeded');e.status=429;e.retryAfterSeconds=1000;throw e;};
  const first=await x.service.tick(x.id);assert.equal(first.reason,'Quota exceeded');assert.equal(attempts,1);
  const restarted=new BackgroundBrochureService(x.repo,x.deps);const cooled=await restarted.tick(x.id);assert.equal(cooled.state,'cooldown');assert.equal(cooled.reason,'Quota exceeded');assert.equal(x.service.status(actor).data.Batch.PauseReason,'Quota exceeded');assert.equal(attempts,1);
  x.advance(1000001);await restarted.tick(x.id);assert.equal(attempts,2);
  x.service.setEnabled(actor,false);assert.equal((await restarted.tick(x.id)).state,'paused');assert.equal(attempts,2);
});
test('manual data, configuration prices and photos are protected; conflicts are retained for review',()=>{
  const item={};const p={BuilderName:'Manual developer',PriceMin:7,ConfigDetails:[{FloorPlanMediaID:'real-photo',PriceMin:7}],Amenities:['Garden']};
  const proposed={BuilderName:'Printed developer',PriceMin:8,ConfigDetails:[{Type:'Apartment',FloorPlanMediaID:'invented',PriceMin:9}],Amenities:['Gym'],Notes:'evidence'};
  const payload=fillMissing(p,proposed,item);assert.deepEqual(payload,{Notes:'evidence'});assert.ok(item.ReviewFields.includes('ConfigDetails'));
  const empty=fillMissing({},proposed,{});assert.equal(empty.ConfigDetails[0].FloorPlanMediaID,undefined);assert.equal(empty.ConfigDetails[0].PriceMin,undefined);
});
test('revoked or cross-tenant owner stops processing and disables automation',async()=>{
  const x=setup();const db=x.repo.read();db.Users[0].BrokerageID='other';x.repo.write(db);
  assert.equal((await x.service.tick(x.id)).state,'disabled');assert.equal(x.calls(),0);assert.equal(x.service.get(actor).Enabled,false);
  assert.throws(()=>x.service.setEnabled({userId:'admin'},true),/Tenant-scoped/);
});
test('new stored PDFs join the existing queue exactly once; identity mismatch requires review',async()=>{
  const x=setup();await x.service.tick(x.id);
  const db=x.repo.read();db.BuilderProjects[0].Brochures.push(pdf('two'),pdf('two'));x.repo.write(db);
  x.deps.extract=async()=>({ProjectName:'Wrong phase',CompletenessReview:{Version:REVIEW_VERSION,Status:'automated_checks_passed'}});
  await x.service.tick(x.id);const status=x.service.status(actor).data;assert.equal(status.Batch.Total,2);assert.equal(status.Batch.Failed,1);assert.equal(status.NeedsReview,1);
  assert.match(status.Batch.Items[1].Error,/does not match/);await x.service.tick(x.id);assert.equal(x.service.status(actor).data.Batch.Total,2);
});
test('project changes during extraction prevent automatic writes',async()=>{
  const x=setup();x.deps.extract=async()=>{const db=x.repo.read();db.BuilderProjects[0].UpdatedAt='manual edit';x.repo.write(db);return {ProjectName:'Coral Heights',BuilderName:'AI overwrite',CompletenessReview:{Version:REVIEW_VERSION,Status:'automated_checks_passed'}};};
  await x.service.tick(x.id);assert.equal(x.service.status(actor).data.Batch.Failed,1);assert.equal(x.repo.list('BuilderProjects')[0].BuilderName,undefined);
});
