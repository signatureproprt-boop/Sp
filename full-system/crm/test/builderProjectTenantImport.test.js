'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BuilderProjectService } = require('../src/services/builderProjectService');

function serviceFor(db) {
  let writes = 0;
  const repo = {
    read: () => db,
    write: () => { writes++; },
    createId: () => 'BLDP-NEW'
  };
  const service = new BuilderProjectService(repo);
  service.parseBuffer = async () => [{ ProjectName: 'Sample', BuilderName: 'Acme', Location1: 'Surat' }];
  service._buildPreviewData = () => ({ columnMap: {}, summary: { missingName: 0 } });
  service.applyMap = (row) => row;
  service.aggregate = (rows) => ({ projects: rows });
  return { service, writes: () => writes };
}

test('scoped CSV import blocks an unscoped legacy identity without writing', async () => {
  const db = { BuilderProjects: [{
    ProjectID: 'BLDP-OLD', ProjectName: 'Sample', BuilderName: 'Acme',
    Location1: 'Surat', Active: true
  }] };
  const { service, writes } = serviceFor(db);
  const out = await service.commit(Buffer.from('ignored'), 'sample.csv', {
    companyId: 'C-1', brokerageId: 'B-1', userId: 'USR-1'
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /tenant metadata/);
  assert.equal(writes(), 0);
  assert.equal(db.BuilderProjects.length, 1);
});

test('scoped CSV import keeps another tenant record separate', async () => {
  const db = { BuilderProjects: [{
    ProjectID: 'BLDP-OTHER', CompanyID: 'C-2', BrokerageID: 'B-2',
    ProjectName: 'Sample', BuilderName: 'Acme', Location1: 'Surat', Active: true
  }] };
  const { service, writes } = serviceFor(db);
  const out = await service.commit(Buffer.from('ignored'), 'sample.csv', {
    companyId: 'C-1', brokerageId: 'B-1', userId: 'USR-1'
  });
  assert.equal(out.ok, true);
  assert.equal(writes(), 1);
  assert.equal(db.BuilderProjects.length, 2);
  assert.equal(db.BuilderProjects[0].ProjectID, 'BLDP-OTHER');
  assert.equal(db.BuilderProjects[1].CompanyID, 'C-1');
  assert.equal(db.BuilderProjects[1].BrokerageID, 'B-1');
});
