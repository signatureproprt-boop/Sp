const test = require('node:test');
const assert = require('node:assert/strict');
const {planMigration: buildPlan,SOURCE_ID} = require('../src/services/sheetMigrationService');
const planMigration = (db,source,actor={role:'ADMIN',userId:'test-admin'}) => buildPlan(db,source,actor);
const input = (...records) => ({spreadsheetId:SOURCE_ID,records});
const row = (phone='9876543210',extra={}) => ({tab:'Comm',sourceRow:2,row:{'Lead ID':'COMM-1',Name:'Client',Phone:phone,Budget:'1L',...extra}});
test('fills blanks while preserving CRM work and existing requirements',()=>{
 const db={Leads:[{LeadID:'COMM-1',PrimaryMobile:'+91 98765 43210',ClientStatus:'Lost',Notes:'CRM note',NextFollowUp:'tomorrow',SheetBasicRequirements:[{SourceTab:'Comm',BudgetMax:50000}]}],Transactions:[{TransactionID:'T1'}],Requirements:[{RequirementID:'R1'}]};
 const {next,report}=planMigration(db,input(row('9876543210',{Status:'New',Remarks:'sheet note'})));
 assert.equal(next.Leads[0].ClientName,'Client');assert.equal(next.Leads[0].ClientStatus,'Lost');assert.equal(next.Leads[0].Notes,'CRM note');assert.equal(next.Leads[0].NextFollowUp,'tomorrow');assert.equal(next.Leads[0].SheetBasicRequirements[0].BudgetMax,50000);
 assert.deepEqual(next.Transactions,db.Transactions);assert.deepEqual(next.Requirements,db.Requirements);assert.equal(db.Leads[0].ClientName,undefined);assert.equal(report.updated,1);
 assert.equal(planMigration(next,input(row('9876543210',{Status:'New',Remarks:'sheet note'}))).report.updated,0);
});
test('new client has basic need only and retry creates nothing',()=>{
 const src=input(row());const first=planMigration({Leads:[]},src);assert.equal(first.report.created,1);assert.equal(first.next.Transactions,undefined);assert.equal(first.next.Leads[0].SheetBasicRequirements.length,1);assert.equal(planMigration(first.next,src).report.created,0);
});
test('duplicate client ID and ID owned by another phone are skipped',()=>{
 for(const leads of [[{LeadID:'COMM-1',PrimaryMobile:'9876543210'},{LeadID:'COMM-1',PrimaryMobile:'8765432109'}],[{LeadID:'COMM-1',PrimaryMobile:'8765432109'}]]) {
 const result=planMigration({Leads:leads},input(row()));assert.equal(result.report.changes.length,0);assert.equal(result.report.issues.length,1);assert.deepEqual(result.next.Leads,leads);
 }
});
test('invalid phones and conflicting source versions cannot mutate clients',()=>{
 const result=planMigration({Leads:[]},input(row('#ERROR!'),row('9876543210'),row('9876543210',{Budget:'2L'}),row('-8511877241')));assert.equal(result.report.changes.length,0);assert.equal(result.next.Leads.length,0);assert.equal(result.report.issues.length,4);
});
test('preview token changes if client work changes and scope is enforced',()=>{
 const db={Leads:[{LeadID:'COMM-1',PrimaryMobile:'9876543210',CompanyID:'A'}]};const src=input(row());const first=planMigration(db,src,{companyId:'B'});assert.equal(first.report.updated,0);assert.equal(first.report.issues.length,1);
 const changed=structuredClone(db);changed.Leads[0].Notes='new';assert.notEqual(planMigration(db,src).report.token,planMigration(changed,src).report.token);
});
test('uses canonical admin access for legacy clients without tenant columns',()=>{
 const db={Leads:[{LeadID:'COMM-1',PrimaryMobile:'9876543210',AssignedAgentID:'USR-0001'}]};
 const result=planMigration(db,input(row()),{role:'ADMIN',userId:'admin',companyId:'C1',brokerageId:'B1'});
 assert.equal(result.report.updated,1);assert.equal(result.report.issues.length,0);
});
test('multiple source tabs count one updated client',()=>{
 const db={Leads:[{LeadID:'COMM-1',PrimaryMobile:'9876543210'}]};
 const sale=row();sale.tab='Sale';const result=planMigration(db,input(row(),sale));
 assert.equal(result.report.updated,1);assert.equal(result.report.changes.length,2);
});
test('reviewed repeated numbers retain every row on one client and are idempotent',()=>{
 const src={...input(row('9876543210'),{...row('9876543210',{'Lead ID':'COMM-2',Budget:'2L'}),sourceRow:3}),reviewedRows:true};
 const {next,report}=planMigration({Leads:[]},src);
 assert.equal(report.created,1);assert.equal(report.issues.length,0);assert.equal(next.Leads.length,1);
 assert.deepEqual(next.Leads[0].Tags,['Duplicate Number']);
 assert.equal(next.Leads[0].SheetBasicRequirements.length,2);
 assert.deepEqual(next.Leads[0].ImportedSheetDetails.map(x=>x.Columns.Budget),['1L','2L']);
 assert.equal(planMigration(next,src).report.changes.length,0);
});
test('reviewed invalid number is retained without a fabricated callable number or Lost status',()=>{
 const src={...input(row('-8511877241')),reviewedRows:true};const {next,report}=planMigration({Leads:[]},src);
 assert.equal(report.created,1);const lead=next.Leads[0];assert.equal(lead.PhoneValidity,'INVALID');assert.equal(lead.InvalidPhoneRaw,'-8511877241');assert.notEqual(lead.PrimaryMobile,'9000000000');assert.equal(lead.ClientStatus,'New');assert.deepEqual(lead.Tags,['Invalid Number']);
 assert.equal(planMigration(next,src).report.changes.length,0);
});
test('reviewed mode still blocks ambiguous CRM mapping and invalid-row ID collisions',()=>{
 const db={Leads:[{LeadID:'COMM-1',PrimaryMobile:'9876543210'},{LeadID:'COMM-1',PrimaryMobile:'8765432109'}]};
 const result=planMigration(db,{...input(row(),row('-8511877241')),reviewedRows:true});assert.deepEqual(result.next.Leads,db.Leads);assert.equal(result.report.issues.length,2);
});
test('confirmed distinct source identity is repaired without guessing work ownership',()=>{
 const db={Leads:[{LeadID:'COMM-1',LegacyID:'COMM-1',ClientName:'Other',PrimaryMobile:'8765432109'},{LeadID:'COMM-1',LegacyID:'RENT-1',ClientName:'Client',PrimaryMobile:'#ERROR!',SheetBasicRequirements:[{SourceTab:'Comm'},{SourceTab:'Rent'}]}],Transactions:[{TransactionID:'T1',LeadID:'COMM-1'}]};
 const src={...input({...row('9876543210',{'Lead ID':'RENT-1'}),tab:'Rent'}),reviewedRows:true,identityRepairs:[{oldLeadId:'COMM-1',legacyId:'RENT-1',sourceTab:'Rent',sourceRow:2}]};
 const result=planMigration(db,src);assert.equal(result.next.Leads[1].LeadID,'RENT-1');assert.equal(result.next.Leads[1].PrimaryMobile,'9876543210');assert.equal(result.next.Leads[0].LeadID,'COMM-1');assert.equal(result.next.Transactions[0].LeadID,'COMM-1');assert.ok(result.next.Transactions[0].IdentityMappingReview);assert.equal(result.report.issues.length,0);assert.equal(planMigration(result.next,src).report.changes.length,0);
 assert.notEqual(planMigration(db,src).report.token,planMigration({...db,Transactions:[]},src).report.token);
 assert.throws(()=>planMigration(db,src,{role:'AGENT'}),/administrator/);
});
test('negative source numbers match original imported country-prefixed phone without guessing a correction',()=>{
 const db={Leads:[{LeadID:'COMM-1',LegacyID:'COMM-1',ClientName:'Client',PrimaryMobile:'+91 85118 77241',CreatedBy:'GoogleSheetSync'}]};
 const result=planMigration(db,{...input(row('-8511877241')),reviewedRows:true});assert.equal(result.report.issues.length,0);assert.equal(result.next.Leads.length,1);assert.equal(result.next.Leads[0].PhoneValidity,'INVALID');assert.equal(result.next.Leads[0].PrimaryMobile,'+91 85118 77241');assert.equal(result.next.Leads[0].InvalidPhoneRaw,'-8511877241');
});
