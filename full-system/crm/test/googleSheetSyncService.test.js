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
