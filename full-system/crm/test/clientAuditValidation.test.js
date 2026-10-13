'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {V2LeadService,isValidPhone}=require('../src/services/v2LeadService');
test('invalid identity is rejected before client create or edit writes',()=>{
 const db={Leads:[{LeadID:'L1',PrimaryMobile:'9876543210'}]};
 let writes=0;
 const svc=new V2LeadService({read:()=>db,write:()=>writes++});
 for(const phone of ['0000000000','abc','abc9876543210','123','']){
  assert.equal(svc.createLead({ClientName:'Audit',PrimaryMobile:phone}).ok,false);
  assert.equal(svc.updateLead('L1',{PrimaryMobile:phone}).ok,false);
 }
 assert.equal(writes,0);
 assert.equal(isValidPhone('+91 98765-43210'),true);
});

test('unchanged client score reads do not queue snapshots or alter client edit time',()=>{
 const {V2ScoringService}=require('../src/services/v2ScoringService');
 const db={Leads:[{LeadID:'L1',UpdatedAt:'2026-01-01'}]};
 let writes=0;
 const svc=new V2ScoringService({read:()=>db,write:()=>writes++});
 let score=25;
 svc.calculateClientScore=()=>({ok:true,score,calculationVersion:'test',calculatedAt:new Date().toISOString(),factors:[]});
 assert.equal(svc.recalculateClientScore('L1').ok,true);
 assert.equal(svc.recalculateClientScore('L1').unchanged,true);
 assert.equal(writes,1);
 assert.equal(db.Leads[0].UpdatedAt,'2026-01-01');
 score=50;
 assert.equal(svc.recalculateClientScore('L1').ok,true);
 assert.equal(writes,2);
});

test('ambiguous lead IDs cannot mutate the first matching record',()=>{
 const db={Leads:[{LeadID:'collision',ClientName:'One'},{LeadID:'collision',ClientName:'Two'}]};
 const svc=new V2LeadService({read:()=>db,write:()=>assert.fail('must not write')});
 assert.equal(svc.updateLead('collision',{ClientName:'Replacement'}).code,'AMBIGUOUS_CLIENT_ID');
 assert.deepEqual(db.Leads.map(l=>l.ClientName),['One','Two']);
});

test('duplicate capture cannot resolve a shared ID to the wrong client',()=>{
 const {V2QuickCaptureService}=require('../src/services/v2QuickCaptureService');
 const repo={read:()=>({Leads:[{LeadID:'shared'},{LeadID:'shared'}]}),readLead:()=>assert.fail('must not choose first record')};
 const svc=new V2QuickCaptureService(repo,{checkDuplicate:()=>({result:'EXACT_MATCH',candidates:[{LeadID:'shared'}]})});
 const result=svc.capture({client:{name:'Second',primaryMobile:'9876543210'}});
 assert.equal(result.code,'AMBIGUOUS_CLIENT_ID');
 assert.equal(result.statusCode,409);
});
