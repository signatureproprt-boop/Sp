'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { directionFor, VastuAnalysisService } = require('../src/services/vastuAnalysisService');

const actor = { userId:'U1',companyId:'C1',brokerageId:'B1' };
const source = { sha256:'a'.repeat(64),page:1,width:1000,height:800,name:'plan.pdf' };
const north = { centerX:.1,centerY:.1,tipX:.1,tipY:.03 };
const region = { x:.1,y:.1,w:.8,h:.8,confirmed:true,rooms:[{ type:'Kitchen',x:.8,y:.8 }] };
function repo() {
  const db = { BuilderProjects:[{ ProjectID:'P1',ProjectName:'Project',CompanyID:'C1',BrokerageID:'B1' }], VastuAnalyses:[],VastuReportRecipients:[],Leads:[{LeadID:'L1',ClientName:'Buyer',PrimaryMobile:'9876543210',CompanyID:'C1',BrokerageID:'B1'}],BrokerProfile:{ Name:'Real Broker',Mobile:'9876543210' } };
  return {
    read:() => structuredClone(db),
    list:(key) => structuredClone(db[key] || []),
    find:(key,field,id) => structuredClone((db[key] || []).find((r) => r[field] === id) || null),
    createId:() => 'VA1',
    create:(key,row) => { db[key].push(row); return row; },
    update:(key,field,id,patch) => { const i=db[key].findIndex((r) => r[field] === id); db[key][i]={...db[key][i],...patch}; return structuredClone(db[key][i]); }
  };
}
test('directions use North origin and actual source aspect ratio', () => {
  const box = { w:.5,h:.5 };
  assert.equal(directionFor({ x:.5,y:.1 },box,0,1000,800).direction,'N');
  assert.equal(directionFor({ x:.9,y:.5 },box,0,1000,800).direction,'E');
  assert.equal(directionFor({ x:.9,y:.5 },box,90,1000,800).direction,'N');
  assert.equal(directionFor({ x:.5,y:.5 },box,0,1000,800).direction,'Center');
});
test('draft saves and final snapshot stays immutable', () => {
  const svc = new VastuAnalysisService(repo());
  const input = { projectId:'P1',propertyType:'residential',spaceType:'Flat',layoutCount:1,source,north,layouts:[region] };
  const draft = svc.saveDraft(input,actor);
  assert.equal(draft.North.angle,0);
  assert.equal(draft.Layouts[0].rooms[0].direction,'SE');
  const final = svc.finalize(draft.AnalysisID,actor);
  assert.equal(final.Status,'final');
  assert.deepEqual(final.IdentitySnapshot,{ name:'Real Broker',mobile:'9876543210',agency:'Signature Properties' });
  assert.throws(() => svc.saveDraft({ ...input,analysisId:draft.AnalysisID },actor),/already finalized/);
  assert.throws(() => svc.finalize(draft.AnalysisID,actor),/already finalized/);
});
test('tenant and source validation stop wrong project and unverified source', () => {
  const svc = new VastuAnalysisService(repo());
  const input = { projectId:'P1',propertyType:'commercial',spaceType:'Shop',layoutCount:1,source,north,layouts:[{...region,rooms:[{type:'Storage',x:.7,y:.4}]}] };
  assert.throws(() => svc.saveDraft(input,{...actor,companyId:'C2'}),/not available/);
  assert.throws(() => svc.saveDraft({...input,source:{...source,sha256:''}},actor),/SHA-256/);
  assert.throws(() => svc.saveDraft({...input,layoutCount:2,layouts:[region,region]},actor),/Confirm printed North/);
});
test('cannot finalize when selected layout count is incomplete', () => {
  const svc = new VastuAnalysisService(repo());
  const draft = svc.saveDraft({ projectId:'P1',propertyType:'residential',spaceType:'Flat',layoutCount:2,source,north,layouts:[region] },actor);
  assert.throws(() => svc.finalize(draft.AnalysisID,actor),/every selected layout/);
});
test('final report links to an existing client without claiming delivery or identity of opener', () => {
  const svc = new VastuAnalysisService(repo());
  const draft = svc.saveDraft({ projectId:'P1',propertyType:'residential',spaceType:'Flat',layoutCount:1,source,north,layouts:[region] },actor);
  svc.finalize(draft.AnalysisID,actor);
  const receipt = svc.recordManualShare(draft.AnalysisID,'L1','whatsapp',actor);
  assert.equal(receipt.RecipientSnapshot.name,'Buyer');
  assert.equal(receipt.Status,'manual_share_recorded');
  assert.equal(receipt.DeliveryStatus,null);
  assert.equal(receipt.OpenedAt,null);
  assert.equal(svc.recipients(draft.AnalysisID,actor).length,1);
  assert.throws(() => svc.recordManualShare(draft.AnalysisID,'missing','whatsapp',actor),/Client not available/);
});
