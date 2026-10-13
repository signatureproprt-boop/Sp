'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProjectMediaCanaryMigrationService } = require('../src/services/projectMediaCanaryMigrationService');

test('serves a verified brochure linked with DriveFileId', async () => {
  const data = Buffer.from('%PDF-1.4\n');
  const repo = { read: () => ({ BuilderProjects: [{
    ProjectID: 'BLDP-1', Brochures: [{ DriveFileId: 'file-1', verified: true, downloadStatus: 'downloaded' }]
  }] }) };
  const svc = new ProjectMediaCanaryMigrationService(repo, {
    drive: { files: { get: async ({ fileId, alt }) => {
      assert.equal(fileId, 'file-1');
      assert.equal(alt, 'media');
      return { data };
    } } }
  });
  const result = await svc.getProjectBrochureFile('BLDP-1');
  assert.equal(result.ok, true);
  assert.deepEqual(result.buffer, data);
});
