'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../scripts/repairLegacyBuilderTenants');

function snapshot(projects, users = [{ Status: 'ACTIVE', CompanyID: 'COMP-DEFAULT', BrokerageID: 'BRK-DEFAULT' }]) {
  return { payload: { BuilderProjects: projects, Users: users } };
}
test('preflight counts tenantless projects without changing them', () => {
  const input = snapshot([{ ProjectID: 'BLDP-1' }, { ProjectID: 'BLDP-2' }]);
  assert.deepEqual(plan(input), {
    companyId: 'COMP-DEFAULT', brokerageId: 'BRK-DEFAULT', total: 2, unscoped: 2
  });
  assert.equal(input.payload.BuilderProjects[0].CompanyID, undefined);
});
test('preflight rejects mixed tenant and duplicate identities', () => {
  assert.throws(() => plan(snapshot([{ ProjectID: 'BLDP-1', CompanyID: 'OTHER', BrokerageID: 'BRK-DEFAULT' }])), /Mixed/);
  assert.throws(() => plan(snapshot([{ ProjectID: 'BLDP-1' }, { ProjectID: 'BLDP-1' }])), /Duplicate/);
  assert.throws(() => plan(snapshot([{ ProjectID: 'BLDP-1' }], [
    { Status: 'ACTIVE', CompanyID: 'COMP-DEFAULT', BrokerageID: 'BRK-DEFAULT' },
    { Status: 'ACTIVE', CompanyID: 'OTHER', BrokerageID: 'BRK-DEFAULT' }
  ])), /exactly one/);
});
