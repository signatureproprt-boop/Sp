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
