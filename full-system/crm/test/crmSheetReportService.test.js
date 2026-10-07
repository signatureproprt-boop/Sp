'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CrmSheetReportService, buildProjection, reconcileRows, cell, HEADERS, TABS, SOURCE_SHEET_ID } = require('../src/services/crmSheetReportService');
const { createReportRunner } = require('../src/services/crmSheetReportRunner');
const fixture = () => ({ Leads: [{ LeadID: 'L1', ClientName: 'Client', PrimaryMobile: '+91 90000 00001', SheetBasicRequirements: [] }],
  Transactions: [{ TransactionID: 'T1', LeadID: 'L1', TransactionType: 'Purchase', Category: 'Residential', TransactionStatus: 'Open' }],
  Requirements: [{ RequirementID: 'R1', TransactionID: 'T1', LeadID: 'L1', Fields: { BudgetMax: { state: 'KNOWN', value: 5000000 } } }], FollowUps: [] });

test('same IDs retain rows through retries, reordered input and edits; obsolete duplicate slots clear', () => {
  const headers = ['ID', 'Name'];
  const old = [headers, ['B', 'before'], ['A', 'first'], ['A', 'duplicate'], ['obsolete', 'x']];
  const next = reconcileRows(headers, [['A', 'updated'], ['B', 'before'], ['C', 'new']], old);
  assert.deepEqual(next.slice(1, 4), [['B', 'before'], ['A', 'updated'], ['C', 'new']]);
  assert.deepEqual(next[4], ['', '']);
  assert.deepEqual(reconcileRows(headers, [['C', 'new'], ['B', 'before'], ['A', 'updated']], next), next);
});
test('Lost and Closed move same work ID between exclusive views and keep master identity', () => {
  const db = fixture();
  const original = JSON.stringify(db);
  let p = buildProjection(db, 'v1');
  assert.equal(p.Sale.length, 1); assert.equal(p.Work.length, 1); assert.equal(p.Requirements[0][6], 5000000);
  assert.equal(JSON.stringify(db), original);
  db.Transactions[0].TransactionStatus = 'Lost'; p = buildProjection(db, 'v2');
  assert.equal(p.Sale.length, 0); assert.equal(p.Lost[0][0], 'TXN:T1');
  db.Transactions[0].TransactionStatus = 'Closed'; p = buildProjection(db, 'v3');
  assert.equal(p.Lost.length, 0); assert.equal(p.Closed[0][0], 'TXN:T1'); assert.equal(p.Clients.length, 1);
});
test('genuine Sale and Rent work stay separate under one client; commercial has priority', () => {
  const db = fixture(); db.Transactions.push({ TransactionID: 'T2', LeadID: 'L1', TransactionType: 'Rent', Category: 'Commercial' });
  const p = buildProjection(db); assert.equal(p.Clients.length, 1); assert.equal(p.Work.length, 2);
  assert.equal(p.Sale.length, 1); assert.equal(p.Comm.length, 1); assert.equal(p.Rent.length, 0);
});
test('ambiguous source IDs do not overwrite or misassign clients; malformed and orphan data is reported', () => {
  const db = fixture(); db.Leads.push({ LeadID: 'L1', ClientName: 'Different person' }); db.Transactions.push({});
  const p = buildProjection(db); assert.equal(p.Clients.length, 0); assert.equal(p.Work.length, 0);
  assert.ok(p['Sync Issues'].some(row => row[3].includes('Duplicate LeadID')));
  assert.ok(p['Sync Issues'].some(row => row[3].includes('Missing TransactionID')));
});
test('same normalized phone with different IDs is flagged, never silently merged', () => {
  const db = fixture(); db.Leads.push({ LeadID: 'L2', PrimaryMobile: '9000000001' });
  const p = buildProjection(db); assert.equal(p.Clients.length, 0); assert.equal(p.Work.length, 0); assert.ok(p['Sync Issues'].length);
});
test('imported source need is not duplicated beside its existing imported transaction', () => {
  const db = fixture(); db.Transactions[0]._source = 'GoogleSheet:Sale';
  db.Leads[0].SheetBasicRequirements = [{ SourceTab: 'Sale', TransactionType: 'Purchase', Category: 'Residential' }, { SourceTab: 'Rent', TransactionType: 'Rent', Category: 'Residential' }];
  const p = buildProjection(db); assert.equal(p.Work.length, 2); assert.equal(p.Sale.length, 1); assert.equal(p.Rent[0][0], 'BASIC:L1:Rent');
});
test('phones and formula-like notes are literal string values', () => {
  for (const value of ['+91 90000 00001', '=IMPORTXML("x")', '-9000000001']) assert.deepEqual(cell(value), { userEnteredValue: { stringValue: value } });
  assert.deepEqual(cell(0), { userEnteredValue: { numberValue: 0 } });
});
test('new confirmed work replaces the preliminary same-kind view without deleting CRM basics', () => {
  const db = fixture(); db.Leads[0].SheetBasicRequirements = [{ SourceTab: 'Sale', TransactionType: 'Purchase', Category: 'Residential' }];
  assert.equal(buildProjection(db).Work.length, 1);
  assert.equal(db.Leads[0].SheetBasicRequirements.length, 1);
});
test('Lost client with no transaction is visible and active work of another client remains active', () => {
  const db = fixture(); db.Leads.push({ LeadID: 'L2', ClientStatus: 'Lost', ClientName: 'Other' });
  const p = buildProjection(db); assert.equal(p.Lost[0][0], 'LEAD:L2'); assert.equal(p.Sale[0][0], 'TXN:T1');
});
test('original Sheet cannot be a report destination', () => {
  assert.throws(() => new CrmSheetReportService({ spreadsheetId: SOURCE_SHEET_ID }));
  assert.throws(() => new CrmSheetReportService({ spreadsheetId: 'same', sourceSheetId: 'same' }));
});
function fakeSheets() {
  let writes = 0;
  const values = Object.fromEntries(TABS.map(t => [t, [HEADERS[t]]]));
  const api = { spreadsheets: {
    get: async () => ({ data: { sheets: TABS.map((title, sheetId) => ({ properties: { title, sheetId, gridProperties: { rowCount: 1000 } } })) } }),
    values: { batchGet: async () => ({ data: { valueRanges: TABS.map(t => ({ values: values[t] })) } }) },
    batchUpdate: async ({ requestBody }) => {
      writes++;
      for (const { updateCells: u } of requestBody.requests) if (u) values[TABS[u.range.sheetId]] = u.rows.map(row => row.values.map(c => c.userEnteredValue?.stringValue ?? c.userEnteredValue?.numberValue ?? ''));
      return { data: {} };
    }
  } };
  return { api, values, writes: () => writes };
}
test('two full syncs and Lost transition use atomic updates and no append; retries produce one record', async () => {
  const fake = fakeSheets(); const svc = new CrmSheetReportService({ sheets: fake.api, spreadsheetId: 'report' }); const db = fixture();
  await svc.sync(db, 'v1'); const first = structuredClone(fake.values); await svc.sync(db, 'v1'); assert.deepEqual(fake.values, first);
  db.Transactions[0].TransactionStatus = 'Lost'; await svc.sync(db, 'v2');
  assert.equal(fake.writes(), 3); assert.equal(fake.values.Sale.filter(row => row[0] === 'TXN:T1').length, 0);
  assert.equal(fake.values.Lost.filter(row => row[0] === 'TXN:T1').length, 1);
  fake.values.Clients[0][0] = 'bad header'; await assert.rejects(svc.sync(db, 'v3')); assert.equal(fake.writes(), 3);
});
test('runner acquires shared lock before reading durable snapshot and coalesces concurrent requests', async () => {
  const events = []; let reads = 0;
  const mongoStore = { isInitialized: () => true,
    withDistributedLock: async (_, fn) => { events.push('lock'); return { acquired: true, result: await fn() }; },
    getDb: () => ({ collection: () => ({ findOne: async () => { events.push('read'); reads++; return { payload: fixture(), updatedAt: new Date(0) }; } }) }) };
  const runner = createReportRunner({ mongoStore, env: { CRM_REPORT_SHEET_ID: 'report' }, serviceFactory: () => ({ sync: async () => { events.push('write'); return { ok: true, complete: true }; } }) });
  await Promise.all([runner.run(), runner.run()]); assert.equal(reads, 1); assert.deepEqual(events, ['lock', 'read', 'write']);
});
test('client edits and multiple requirements share one cell; related work follows same identity', () => {
  const db = fixture(); db.Leads[0].BudgetMax = 7000000;
  db.Requirements = []; db.Transactions = [];
  db.Shortlists = [{ShortlistID:'S1',LeadID:'L1',PropertyID:'P1'}];
  db.SiteVisits = [{VisitID:'V1',LeadID:'L1',Status:'Scheduled'}];
  let p = buildProjection(db);
  assert.equal(p.Clients.length,1); assert.match(p.Clients[0][10],/7000000/);
  const work = JSON.parse(p.Clients[0][11]); assert.equal(work.Shortlists[0].PropertyID,'P1'); assert.equal(work.SiteVisits[0].VisitID,'V1');
  db.Requirements = [{RequirementID:'R2',LeadID:'L1',BudgetMax:8000000},{RequirementID:'R1',LeadID:'L1',TransactionType:'Rent',BudgetMax:50000}];
  p=buildProjection(db); assert.equal(p.Clients.length,1); assert.match(p.Clients[0][10],/R1:.*50000\nR2:.*8000000/);
});
test('legacy reporting Clients headers upgrade once; future syncs keep fixed schema', async () => {
  const fake=fakeSheets(); fake.values.Clients[0]=HEADERS.Clients.slice(0,10);
  const svc=new CrmSheetReportService({sheets:fake.api,spreadsheetId:'report'});
  await svc.sync(fixture(),'v1'); assert.deepEqual(fake.values.Clients[0],HEADERS.Clients);
  await svc.sync(fixture(),'v2'); assert.equal(fake.values.Clients.length,2);
});

test('profile details and current follow-up are included alongside confirmed needs', () => {
 const db=fixture();Object.assign(db.Leads[0],{RequirementType:'Rent',NextFollowUpAt:'2026-10-12',RequirementProfile:{Location2:'Vesu'}});
 const p=buildProjection(db);assert.equal(p.Clients[0][6],'2026-10-12');assert.match(p.Clients[0][10],/Vesu/);assert.match(p.Clients[0][10],/R1:/);
});
