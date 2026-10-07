'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GoogleSheetSyncService } = require('../src/services/googleSheetSyncService');

function makeRepository(seed = {}) {
  let db = structuredClone({
    Leads: [], Transactions: [], Requirements: [],
    _V2Counters: { Lead: 0, Transaction: 0, Requirement: 0 },
    ...seed
  });
  return {
    read: () => structuredClone(db),
    write: (next) => { db = structuredClone(next); },
    snapshot: () => structuredClone(db)
  };
}

test('Sheet sync stores preliminary needs on one client without creating transactions', async () => {
  const repository = makeRepository();
  const service = new GoogleSheetSyncService(repository, { syncToken: 'test-token' });
  const phone = '+91 98765 43210';

  await service.syncRows('Rent', [{
    Name: 'Asha Shah', Phone: phone, Budget: '75L',
    'Preferred Location': 'Vesu', 'BHK/Size': '3 BHK'
  }]);

  let db = repository.snapshot();
  assert.equal(db.Leads.length, 1);
  assert.equal(db.Transactions.length, 0);
  assert.equal(db.Requirements.length, 0);
  assert.equal(db.Leads[0].SheetBasicRequirements.length, 1);
  assert.equal(db.Leads[0].SheetBasicRequirements[0].TransactionType, 'Rent');
  assert.equal(db.Leads[0].SheetBasicRequirements[0].Category, 'Residential');
  assert.equal(db.Leads[0].SheetBasicRequirements[0].BudgetMax, 7_500_000);
  assert.equal(db.Leads[0].SheetBasicRequirements[0].Location1, 'Vesu');
  assert.equal(db.Leads[0].SheetBasicRequirements[0].ConfirmationStatus, 'UNCONFIRMED');

  await service.syncRows('Rent', [{
    Name: 'Asha Shah', Phone: phone, Budget: '80L',
    'Preferred Location': 'Adajan', 'BHK/Size': '3 BHK'
  }]);
  await service.syncRows('Comm', [{
    Name: 'Asha Shah', Phone: phone, Budget: '1L',
    'Preferred Location': 'Ring Road'
  }]);

  db = repository.snapshot();
  assert.equal(db.Leads.length, 1, 'phone match must update the same client');
  assert.equal(db.Leads[0].SheetBasicRequirements.length, 2, 'each Sheet tab keeps one preliminary need');
  assert.equal(db.Leads[0].SheetBasicRequirements.find(row => row.SourceTab === 'Rent').BudgetMax, 8_000_000);
  assert.equal(db.Leads[0].SheetBasicRequirements.find(row => row.SourceTab === 'Comm').Category, 'Commercial');
  assert.deepEqual(db.Leads[0].SheetSourceTabs.sort(), ['Comm', 'Rent']);
  assert.equal(db.Transactions.length, 0, 'Sheet sync must never create an active transaction');
  assert.equal(db.Requirements.length, 0, 'Sheet sync must never create a confirmed requirement');
});

test('Sheet legacy ID collision gets a unique CRM identity', async () => {
  const repository = makeRepository({
    Leads: [{
      LeadID: 'LEAD-0030',
      LegacyID: 'LEAD-0030',
      ClientName: 'Kenil Saha',
      PrimaryMobile: '+91 98765 43210'
    }]
  });
  const service = new GoogleSheetSyncService(repository, { syncToken: 'test-token' });

  const [result] = await service.syncRows('Sale', [{
    'Lead ID': 'LEAD-0030',
    Name: 'Arohi Shah',
    Phone: '+91 91234 56789'
  }]);

  const leads = repository.snapshot().Leads;
  const kenil = leads.find((lead) => lead.ClientName === 'Kenil Saha');
  const arohi = leads.find((lead) => lead.ClientName === 'Arohi Shah');

  assert.equal(result.ok, true);
  assert.equal(leads.length, 2);
  assert.ok(arohi);
  assert.ok(arohi.LeadID);
  assert.notEqual(arohi.LeadID, kenil.LeadID);
  assert.equal(arohi.LegacyID, 'LEAD-0030');
  assert.equal(kenil.PrimaryMobile, '+91 98765 43210');
  assert.equal(result.leadId, arohi.LeadID);
  assert.equal(new Set(leads.map((lead) => lead.LeadID)).size, leads.length);
});


test('invalid Sheet phones never create clients or overwrite an empty-key client', async () => {
  const repository = makeRepository({ Leads: [
    { LeadID: 'OLD', ClientName: 'Existing invalid record', PrimaryMobile: '#ERROR!' },
    { LeadID: 'VALID', ClientName: 'Existing valid record', PrimaryMobile: '+91 98765 43210' }
  ] });
  const before = repository.snapshot();
  const service = new GoogleSheetSyncService(repository);
  for (const Phone of ['#ERROR!', '#N/A', '#REF!', 'None', 'abc9876543210', '123', '9999876543210', '', null]) {
    const [result] = await service.syncRows('Rent', [{ Phone, Name: 'Unrelated client', Budget: '1L' }]);
    assert.equal(result.ok, false, String(Phone));
    assert.deepEqual(repository.snapshot(), before, String(Phone));
  }
});

test('valid Indian phone formats continue to match one client across tabs', async () => {
  const repository = makeRepository();
  const service = new GoogleSheetSyncService(repository);
  for (const Phone of ['9876543210', '+91 98765 43210', '91-98765-43210', '09876543210']) {
    const [result] = await service.syncRows('Rent', [{ Phone, Name: 'Same client' }]);
    assert.equal(result.ok, true);
  }
  assert.equal(repository.snapshot().Leads.length, 1);
});

test('public Sheet sync reports rejected rows while importing valid rows', async () => {
  const repository = makeRepository();
  const service = new GoogleSheetSyncService(repository, { fetchImpl: async () => ({
    ok: true, text: async () => 'Name,Phone\nBad,#ERROR!\nValid,9876543210\n'
  }) });
  const summary = await service.syncPublicSheet({ sheetId: 'fixture', tabs: { Rent: '0' } });
  assert.equal(summary.ok, false);
  assert.equal(summary.failed, 1);
  assert.equal(summary.created, 1);
  assert.equal(repository.snapshot().Leads[0].ClientName, 'Valid');
});
test('repeated source imports preserve CRM name, status, notes and follow-up while refreshing preliminary source need', async () => {
 const repository=makeRepository({Leads:[{LeadID:'L1',PrimaryMobile:'+91 98765 43210',ClientName:'Call confirmed',ClientStatus:'Lost',Notes:'CRM note',NextFollowUp:'2026-10-10'}]});
 const svc=new GoogleSheetSyncService(repository,{syncToken:'test'});
 await svc.syncRows('Sale',[{'Lead ID':'OLD','Phone':'9876543210','Name':'Old name','Status':'New','Remarks':'Old note','Next Follow-up Date':'2026-10-01','Budget':'50 L'}]);
 const db=repository.snapshot();assert.equal(db.Leads.length,1);const lead=db.Leads[0];
 assert.equal(lead.ClientName,'Call confirmed');assert.equal(lead.ClientStatus,'Lost');assert.equal(lead.Notes,'CRM note');assert.equal(lead.NextFollowUp,'2026-10-10');assert.equal(lead.SheetBasicRequirements[0].BudgetMax,5000000);
 assert.equal(db.Transactions.length,0);assert.equal(db.Requirements.length,0);
});
