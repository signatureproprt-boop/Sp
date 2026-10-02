'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { directionFor, VastuAnalysisService } = require('../src/services/vastuAnalysisService');

const actor = { userId:'U1',companyId:'C1',brokerageId:'B1' };
const source = { sha256:'a'.repeat(64),page:1,width:1000,height:800,name:'plan.pdf' };
const north = { centerX:.1,centerY:.1,tipX:.1,tipY:.03 };
const region = { x:.1,y:.1,w:.8,h:.8,confirmed:true,rooms:[{ type:'Kitchen',x:.8,y:.8,reviewStatus:'accepted' }] };
function repo() {
  const db = { BuilderProjects:[{ ProjectID:'P1',ProjectName:'Project',CompanyID:'C1',BrokerageID:'B1' }],Inventory:[{PropertyID:'PROP-1',Title:'Flat A-101',ProjectID:'P1',Category:'Residential',CompanyID:'C1',BrokerageID:'B1'},{PropertyID:'PROP-2',Title:'Standalone Shop',Category:'Commercial',CompanyID:'C1',BrokerageID:'B1'},{PropertyID:'PROP-3',Title:'Flat A-102',ProjectID:'P1',Category:'Residential',CompanyID:'C1',BrokerageID:'B1'}], VastuAnalyses:[],VastuReportRecipients:[],VastuSources:[],Leads:[{LeadID:'L1',ClientName:'Buyer',PrimaryMobile:'9876543210',CompanyID:'C1',BrokerageID:'B1'}],BrokerProfile:{ Name:'Real Broker',Mobile:'9876543210' } };
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
test('two flat centers stay independent and saved directions use each center', () => {
  const svc = new VastuAnalysisService(repo());
  const layouts = [
    {...region,centerX:.2,centerY:.5,rooms:[{type:'Kitchen',x:.5,y:.5}]},
    {...region,centerX:.8,centerY:.5,rooms:[{type:'Kitchen',x:.5,y:.5}]}
  ];
  const draft = svc.saveDraft({projectId:'P1',propertyType:'residential',spaceType:'Flat',layoutCount:2,source,north:{...north,scopeConfirmed:true},layouts},actor);
  assert.equal(draft.Layouts[0].rooms[0].direction,'E');
  assert.equal(draft.Layouts[1].rooms[0].direction,'W');
  assert.deepEqual(draft.Layouts.map((layout) => layout.centerX),[.2,.8]);
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
  const input = { projectId:'P1',propertyType:'commercial',spaceType:'Shop',layoutCount:1,source,north,layouts:[{...region,rooms:[{type:'Storage',x:.7,y:.4,reviewStatus:'accepted'}]}] };
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
test('links an existing Inventory property, freezes title and rejects mismatched project or draft switch', () => {
  const svc = new VastuAnalysisService(repo());
  const input = { propertyId:'PROP-1',projectId:'P1',propertyType:'residential',spaceType:'Flat',layoutCount:1,source,north,layouts:[region] };
  const draft = svc.saveDraft(input,actor);
  assert.equal(draft.PropertyID,'PROP-1');
  assert.equal(draft.PropertyTitle,'Flat A-101');
  assert.equal(svc.list('P1',actor,'PROP-1').length,1);
  assert.throws(() => svc.saveDraft({...input,projectId:'P2'},actor),/different project/);
  assert.throws(() => svc.saveDraft({...input,propertyId:'missing'},actor),/Property not found/);
  assert.throws(() => svc.saveDraft({...input,projectId:null,propertyId:'PROP-2',analysisId:draft.AnalysisID},actor),/Draft unavailable/);
  svc.finalize(draft.AnalysisID,actor);
  assert.equal(svc.recordManualShare(draft.AnalysisID,'L1','whatsapp',actor).PropertyID,'PROP-1');
});
test('standalone Inventory property supports an analysis without a builder project', () => {
  const svc = new VastuAnalysisService(repo());
  const row = svc.saveDraft({ propertyId:'PROP-2',propertyType:'commercial',spaceType:'Shop',layoutCount:1,source,north,layouts:[{...region,rooms:[{type:'Storage',x:.7,y:.4,reviewStatus:'accepted'}]}] },actor);
  assert.equal(row.ProjectID,null);
  assert.equal(row.PropertyTitle,'Standalone Shop');
  assert.equal(svc.list(null,actor,'PROP-2').length,1);
  const edited = svc.saveDraft({propertyId:'PROP-2',analysisId:row.AnalysisID,propertyType:'commercial',spaceType:'Shop',layoutCount:1,source,north,layouts:[{...region,propertyId:'PROP-2',rooms:[{type:'Storage',x:.7,y:.4,reviewStatus:'accepted'}]}]},actor);
  assert.equal(edited.Layouts[0].PropertyID,'PROP-2');
});
test('final requires human review and explicit note at sector boundary', () => {
  const svc = new VastuAnalysisService(repo());
  const input = { projectId:'P1',propertyType:'residential',spaceType:'Flat',layoutCount:1,source,north,layouts:[{...region,rooms:[{type:'Entrance',x:.57,y:.05}]}] };
  const draft = svc.saveDraft(input,actor);
  assert.throws(() => svc.finalize(draft.AnalysisID,actor),/Review every space/);
  const revised = svc.saveDraft({...input,analysisId:draft.AnalysisID,layouts:[{...region,rooms:[{type:'Entrance',x:.57,y:.05,reviewStatus:'accepted'}]}]},actor);
  assert.equal(revised.Layouts[0].rooms[0].boundaryReview,true);
  assert.throws(() => svc.finalize(draft.AnalysisID,actor),/note/);
  svc.saveDraft({...input,analysisId:draft.AnalysisID,layouts:[{...region,rooms:[{type:'Entrance',x:.57,y:.05,reviewStatus:'accepted',reviewNote:'Boundary checked on original plan'}]}]},actor);
  assert.equal(svc.finalize(draft.AnalysisID,actor).Status,'final');
});
test('combined project report links each confirmed layout to its own Inventory unit', () => {
  const svc = new VastuAnalysisService(repo());
  const input = { projectId:'P1',propertyType:'residential',spaceType:'Flat',layoutCount:2,source,north:{...north,scopeConfirmed:true},layouts:[{...region,propertyId:'PROP-1'},{...region,propertyId:'PROP-3'}] };
  const draft = svc.saveDraft(input,actor);
  assert.equal(draft.Layouts[0].PropertyTitle,'Flat A-101');
  assert.equal(draft.Layouts[1].PropertyTitle,'Flat A-102');
  assert.equal(svc.list('P1',actor,'PROP-3')[0].AnalysisID,draft.AnalysisID);
  svc.finalize(draft.AnalysisID,actor);
  assert.deepEqual(svc.recordManualShare(draft.AnalysisID,'L1','whatsapp',actor).PropertyIDs,['PROP-1','PROP-3']);
  assert.throws(() => svc.saveDraft({...input,layouts:[{...region,propertyId:'PROP-2'}]},actor),/must belong to this project/);
});
test('stored project source reference must belong to the project', () => {
  const svc = new VastuAnalysisService(repo());
  const input = {projectId:'P1',propertyType:'residential',spaceType:'Flat',layoutCount:1,source:{...source,ref:'project-brochure'},north,layouts:[region]};
  assert.equal(svc.saveDraft(input,actor).Source.Ref,'project-brochure');
  assert.throws(() => svc.saveDraft({...input,source:{...source,ref:'MED-other'}},actor),/source reference unavailable/);
});
