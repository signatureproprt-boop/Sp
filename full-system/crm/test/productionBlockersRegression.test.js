'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AccessControlService } = require('../src/services/accessControlService');
const { V2LeadService } = require('../src/services/v2LeadService');
const { V2TransactionService } = require('../src/services/v2TransactionService');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function repositoryWith(initial) {
  let db = clone(initial);
  return {
    read: () => clone(db),
    write: (next) => { db = clone(next); },
    addTimelineEntry: () => {},
    readLead: (leadId) => (db.Leads || []).find((row) => row.LeadID === leadId) || null,
    getUser: () => null,
    getRole: () => null,
    hasPermission: () => false,
    snapshot: () => clone(db)
  };
}

function transactionFixture(overrides = {}) {
  return {
    TransactionID: 'T-1',
    LeadID: 'L-1',
    TransactionType: 'Purchase',
    Type: 'Purchase',
    TransactionStatus: 'Open',
    Status: 'Open',
    PipelineStage: 'New',
    CompanyID: 'C-1',
    BrokerageID: 'B-1',
    BudgetMin: 100,
    BudgetMax: 200,
    Fields: {
      BHKMin: { state: 'KNOWN', value: 2 },
      Furnishing: { state: 'KNOWN', value: 'Furnished' }
    },
    ...overrides
  };
}

test('read permission alone cannot authorize a write route', () => {
  const access = new AccessControlService(repositoryWith({}));
  const viewer = { userId: 'U-1', role: 'AGENT', permissions: ['LEADS_READ'] };

  assert.equal(access.requirePermissions(viewer, ['LEADS_EDIT', 'LEADS_UPDATE', 'LEADS_VIEW', 'LEADS_READ']).ok, false);
  assert.equal(access.requirePermissions(viewer, ['LEADS_VIEW', 'LEADS_READ']).ok, true);
});

test('a view permission for another surface cannot authorize a write route', () => {
  const access = new AccessControlService(repositoryWith({}));
  const viewer = { userId: 'U-1', role: 'AGENT', permissions: ['SITE_VISIT_VIEW', 'LEADS_READ'] };

  assert.equal(access.requirePermissions(viewer, ['SITE_VISIT_VIEW', 'LEADS_EDIT', 'LEADS_UPDATE', 'LEADS_READ']).ok, false);
});

test('edit permission still authorizes a write route and admin remains allowed', () => {
  const access = new AccessControlService(repositoryWith({}));

  assert.equal(access.requirePermissions(
    { userId: 'U-1', role: 'AGENT', permissions: ['LEADS_UPDATE'] },
    ['LEADS_EDIT', 'LEADS_UPDATE', 'LEADS_VIEW', 'LEADS_READ']
  ).ok, true);
  assert.equal(access.requirePermissions(
    { userId: 'ADMIN-1', role: 'ADMIN' },
    ['LEADS_EDIT', 'LEADS_UPDATE', 'LEADS_VIEW', 'LEADS_READ']
  ).ok, true);
});

test('client edit ignores payload attempts to change tenant ownership', () => {
  const repository = repositoryWith({
    Leads: [{
      LeadID: 'L-1',
      ClientName: 'Test Client',
      PrimaryMobile: '9876543210',
      ClientStatus: 'New',
      LeadStatus: 'New',
      ClientLifecycle: 'Prospect',
      CompanyID: 'C-1',
      BrokerageID: 'B-1',
      AssignedAgentID: 'U-1',
      Version: 1
    }]
  });
  const service = new V2LeadService(repository);

  const result = service.updateLead('L-1', {
    Notes: 'Updated note',
    CompanyID: 'C-OTHER',
    companyId: 'C-OTHER',
    BrokerageID: 'B-OTHER',
    brokerageId: 'B-OTHER'
  }, { userId: 'U-1', companyId: 'C-1', brokerageId: 'B-1' });

  assert.equal(result.ok, true);
  assert.equal(result.data.CompanyID, 'C-1');
  assert.equal(result.data.BrokerageID, 'B-1');
});

test('transaction edit persists type aliases and merges partial dynamic fields', () => {
  const repository = repositoryWith({ Transactions: [transactionFixture()] });
  const service = new V2TransactionService(repository);

  const result = service.updateTransactionDetails('T-1', {
    TransactionType: 'Rent',
    BHKMin: 3,
    BudgetMin: 150
  }, { userId: 'U-1' });

  assert.equal(result.ok, true);
  assert.equal(result.data.TransactionType, 'Rent');
  assert.equal(result.data.Type, 'Rent');
  assert.equal(result.data.BHKMin, 3);
  assert.equal(result.data.Fields.BHKMin.value, 3);
  assert.equal(result.data.Fields.Furnishing.value, 'Furnished');
  assert.equal(result.data.BudgetMin, 150);
});

test('transaction edits reject unsupported types and invalid budget ranges', () => {
  const repository = repositoryWith({ Transactions: [transactionFixture()] });
  const service = new V2TransactionService(repository);

  assert.equal(service.updateTransactionDetails('T-1', { TransactionType: 'Unknown' }).ok, false);
  const invalidRange = service.updateTransactionDetails('T-1', { BudgetMin: 300 });
  assert.equal(invalidRange.ok, false);
  assert.match(invalidRange.error, /BudgetMin/);
});

test('transaction detail status updates use validated lifecycle transitions', () => {
  const repository = repositoryWith({ Transactions: [transactionFixture()] });
  const service = new V2TransactionService(repository);

  const hold = service.updateTransactionDetails('T-1', {
    RequirementStatus: 'Paused',
    RequirementStatusReason: 'Client requested a pause'
  }, { userId: 'U-1' });

  assert.equal(hold.ok, true);
  assert.equal(hold.data.TransactionStatus, 'Hold');
  assert.equal(hold.data.HoldReason, 'Client requested a pause');

  const invalid = service.updateTransactionDetails('T-1', { TransactionStatus: 'Invalid' }, { userId: 'U-1' });
  assert.equal(invalid.ok, false);
});
