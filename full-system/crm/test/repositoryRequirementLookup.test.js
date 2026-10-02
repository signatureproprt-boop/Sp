'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonRepository } = require('../src/data/repository');

test('legacy requirement lookup and update use RequirementID within a shared transaction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-req-lookup-'));
  try {
    const repo = new JsonRepository(path.join(dir, 'db.json'));
    const db = repo.read();
    db.Requirements = [
      { RequirementID: 'REQ-1', TransactionID: 'TXN-1', LeadID: 'LEAD-1', Status: 'Active', BudgetMax: 100, VersionNumber: 1 },
      { RequirementID: 'REQ-2', TransactionID: 'TXN-1', LeadID: 'LEAD-1', Status: 'Active', BudgetMax: 200, VersionNumber: 1 }
    ];
    repo.write(db);

    assert.equal(repo.readRequirement('REQ-2').BudgetMax, 200);
    assert.equal(repo.readRequirement('TXN-1'), null);
    const result = repo.updateRequirement('REQ-2', { BudgetMax: 250 });
    assert.equal(result.requirement.RequirementID, 'REQ-2');
    assert.equal(repo.readRequirement('REQ-1').BudgetMax, 100);
    assert.equal(repo.readRequirement('REQ-2').BudgetMax, 250);
    assert.equal(repo.read().RequirementHistory.at(-1).RequirementID, 'REQ-2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
