'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { brochureStatusReport, reportCsv } = require('../src/services/builderBrochureStatusReport');

test('classifies each active visible project and counts verified Drive PDFs', () => {
  const report = brochureStatusReport([
    { ProjectID: '1', ProjectName: 'A', Brochures: [{ verified: true, DriveFileID: 'drive-1', Filename: 'a.pdf' }, { verified: false, DriveFileID: 'unsafe' }] },
    { ProjectID: '2', ProjectName: 'B', BrochureUrl: 'https://example.com/b.pdf' },
    { ProjectID: '3', ProjectName: 'C', Brochures: [{ verified: true, StoragePath: 'local/pdf' }] },
    { ProjectID: '4', ProjectName: 'D' },
    { ProjectID: '5', ProjectName: 'Inactive', Active: false },
    { ProjectID: '6', ProjectName: 'Other tenant' }
  ], (p) => p.ProjectID !== '6');
  assert.deepEqual(report.counts, { totalProjects: 4, driveLinked: 1, storedOutsideDrive: 1, pending: 1, noBrochureSource: 1, linkedFiles: 1 });
  assert.equal(report.rows[0].driveFileIds, 'drive-1');
  assert.equal(report.rows[1].status, 'Pending');
});

test('CSV escapes text and blocks spreadsheet formula execution', () => {
  const csv = reportCsv(brochureStatusReport([{ ProjectID: '1', ProjectName: '=HYPERLINK("x")', BuilderName: 'A,B' }]));
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"A,B"/);
});
