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
