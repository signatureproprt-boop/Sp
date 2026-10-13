'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readSourceRecords,buildSourcePlan,enabledImportActor,SOURCE_ID}=require('../src/services/sourceSheetImportService');
const actor={userId:'admin',role:'ADMIN',companyId:null,brokerageId:null};
const header='Lead ID,Name,Phone,Budget,Status,Custom Detail';

test('read-only source ingestion preserves row numbers, all columns and skips spreadsheet artifacts',async()=>{
 const calls=[];
 const source=await readSourceRecords(async(id,tab)=>{
  calls.push({id,tab});
  return tab==='Rent'?[header,'','','','','','RENT-0006,Dr Arohi,9157060560,30000,Telecalling,retained','error,Broken,#ERROR!,0,,'].join('\n'):
    header+'\n'+(tab==='Comm'?'COMM-0057,Kenil Shah,9167658880,1L,Contacted,original':'SALE-1,Sale Person,9876543210,75L,,original');
 });
 assert.equal(calls.length,3);
 assert.ok(calls.every(c=>c.id===SOURCE_ID));
 assert.equal(source.records.find(r=>r.tab==='Rent').sourceRow,7);
 assert.equal(source.records.find(r=>r.tab==='Rent').row['Custom Detail'],'retained');
 assert.equal(source.skipped.length,1);
 const db={Leads:[]};
 const plan=buildSourcePlan(db,source,actor);
 assert.equal(plan.report.created,3);
 assert.equal((plan.next.Transactions||[]).length,0);
 assert.equal((plan.next.Requirements||[]).length,0);
 assert.equal(plan.next.Leads.find(l=>l.LeadID==='RENT-0006').ImportedSheetDetails[0].Columns['Custom Detail'],'retained');
 assert.equal(buildSourcePlan(plan.next,source,actor).report.changes.length,0);
});

test('verified COMM-0057 repair restores Dr Arohi source identity without assigning shared work',()=>{
 const source={spreadsheetId:SOURCE_ID,reviewedRows:true,records:[{tab:'Rent',sourceRow:7,row:{'Lead ID':'RENT-0006',Name:'Dr Arohi',Phone:'9157060560',Budget:'30000'}}]};
 const db={Leads:[{LeadID:'COMM-0057',LegacyID:'COMM-0057',ClientName:'Kenil Shah',PrimaryMobile:'9167658880'},{LeadID:'COMM-0057',LegacyID:'RENT-0006',ClientName:'Dr Arohi',PrimaryMobile:'9157060560',ClientStatus:'Lost',Notes:'CRM note'}],FollowUps:[{FollowUpID:'F1',LeadID:'COMM-0057'}],Documents:[{DocumentID:'D1',LeadID:'COMM-0057'}]};
 const result=buildSourcePlan(db,source,actor,{repairComm57:true});
 assert.deepEqual(result.next.Leads.map(l=>l.LeadID),['COMM-0057','RENT-0006']);
 assert.equal(result.next.Leads[1].ClientStatus,'Lost');
 assert.equal(result.next.Leads[1].Notes,'CRM note');
 assert.equal(result.next.Leads[1].Phone,'9157060560');
 assert.equal(result.next.FollowUps[0].LeadID,'COMM-0057');
 assert.ok(result.next.FollowUps[0].IdentityMappingReview);
 assert.ok(result.next.Documents[0].IdentityMappingReview);
 assert.equal(buildSourcePlan(result.next,source,actor,{repairComm57:true}).report.changes.length,0);
 assert.throws(()=>buildSourcePlan({...db,Leads:[db.Leads[0],{...db.Leads[1],PrimaryMobile:'8765432109'}]},source,actor,{repairComm57:true}),/phone conflicts/);
});

test('automatic import only uses an enabled, current administrator binding',()=>{
 const db={SourceSheetImport:{enabled:true,sourceId:SOURCE_ID,actor},Users:[{UserID:'admin',Role:'ADMIN',Status:'Active'}]};
 assert.equal(enabledImportActor(db).userId,'admin');
 assert.equal(enabledImportActor({...db,SourceSheetImport:{...db.SourceSheetImport,enabled:false}}),null);
 assert.equal(enabledImportActor({...db,Users:[{UserID:'admin',Role:'AGENT',Status:'Active'}]}),null);
 assert.equal(enabledImportActor({...db,Users:[{UserID:'admin',Role:'ADMIN',Status:'Inactive'}]}),null);
});
