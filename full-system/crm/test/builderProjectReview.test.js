'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BuilderProjectService } = require('../src/services/builderProjectService');
const { brochureStatusReport } = require('../src/services/builderBrochureStatusReport');

function repo(projects) {
  const data = { BuilderProjects: projects };
  return { read: () => data, write: () => {}, list: () => data.BuilderProjects };
}

test('filters BHK and carpet/built-up sizes within the same configuration', () => {
  const service = new BuilderProjectService(repo([
    { ProjectID: 'one', ConfigDetails: [{ Type: '2 BHK', CarpetAreaSqft: 800, BuiltUpAreaSqft: 1000 }, { Type: '3 BHK', CarpetAreaSqft: 1100, BuiltUpAreaSqft: 1400 }] },
    { ProjectID: 'legacy', ConfigDetails: [{ Type: '2 BHK', AreaSqft: 900 }] }
  ]));
  assert.deepEqual(service.list({ bhk: '2 BHK', carpetMin: 750, carpetMax: 850, builtUpMin: 950 }).data.map(p => p.ProjectID), ['one']);
  assert.equal(service.list({ bhk: '2 BHK', carpetMin: 900 }).count, 0);
  assert.equal(service.list({ bhk: '2 BHK' }).count, 2);
});

test('builder selection filters before pagination and combines with category', () => {
  const service = new BuilderProjectService(repo([
    { ProjectID: 'a1', BuilderName: 'Avadh', Category: 'Residential', Active: true },
    { ProjectID: 'other', BuilderName: 'Different', Category: 'Commercial', Active: true },
    { ProjectID: 'a2', BuilderName: 'Avadh', Category: 'Commercial', Active: true },
    { ProjectID: 'a3', BuilderName: 'AVADH', Category: 'Industrial', Active: true }
  ]));
  const page = service.listPage({ builder: 'Avadh', page: 1, limit: 2 });
  assert.equal(page.pagination.total, 3);
  assert.equal(page.pagination.totalPages, 2);
  assert.equal(service.listPage({ builder: 'Avadh', category: 'Commercial' }).data[0].ProjectID, 'a2');
});

test('manual review records who checked and becomes stale after brochure or form changes', () => {
  const project = { ProjectID: 'p1', Active: true, ProjectName: 'Home', BuilderName: 'Builder', Location1: 'Vesu', Brochures: [{ verified: true, DriveFileId: 'file-1' }] };
  const service = new BuilderProjectService(repo([project]));
  assert.equal(service.setReview('p1', 'brochure', true, 'agent-1').ok, true);
  assert.equal(service.setReview('p1', 'form', true, 'agent-1').ok, true);
  assert.equal(brochureStatusReport([project]).rows[0].brochureChecked, true);
  project.Brochures.push({ verified: true, DriveFileId: 'file-2' });
  assert.equal(brochureStatusReport([project]).rows[0].brochureChecked, false);
  assert.equal(service.update('p1', { Address: 'New address' }).ok, true);
  assert.equal(project.FormReview, null);
});

test('land, tower, floor, height and penthouse details survive project edits', () => {
  const project = { ProjectID: 'p-floor', Active: true, ProjectName: 'Tower', BuilderName: 'Builder', Location1: 'Vesu' };
  const service = new BuilderProjectService(repo([project]));
  const result = service.update('p-floor', {
    ProjectArea: '2.5 acres', TotalTowers: '3', TotalFloors: '18', FloorHeightFt: '10.5',
    ConfigDetails: [{ Type: 'Penthouse', CarpetAreaSqft: 2400, BuiltUpAreaSqft: 3000 }]
  });
  assert.equal(result.ok, true);
  assert.equal(project.ProjectArea, '2.5 acres');
  assert.equal(project.TotalTowers, 3);
  assert.equal(project.TotalFloors, 18);
  assert.equal(project.FloorHeightFt, 10.5);
  assert.equal(project.ConfigDetails[0].Type, 'Penthouse');
  assert.equal(project.ConfigDetails[0].BuiltUpAreaSqft, 3000);
});

test('sales contact and distinct penthouse and terrace flat details survive edits', () => {
  const project = { ProjectID: 'p2', Active: true, ProjectName: 'Homes', BuilderName: 'Builder', Location1: 'Vesu' };
  const service = new BuilderProjectService(repo([project]));
  const result = service.update('p2', {
    SalesPersonName: 'Ravi', SalesPersonPhone: '9876543210',
    ConfigDetails: [
      { Type: 'Penthouse', BHK: 4, CarpetAreaSqft: 2100, BuiltUpAreaSqft: 2600, TerraceAreaSqft: 400, ParkingAllotted: 2, ServantRoom: true },
      { Type: 'Terrace Flat', BHK: 3, CarpetAreaSqft: 1500, BuiltUpAreaSqft: 1900, TerraceAreaSqft: 300, ParkingAllotted: 1, ServantRoom: false }
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(project.SalesPersonPhone, '9876543210');
  assert.equal(project.ConfigDetails[0].ParkingAllotted, 2);
  assert.equal(project.ConfigDetails[0].ServantRoom, true);
  assert.equal(project.ConfigDetails[1].BHK, 3);
  assert.equal(project.ConfigDetails[1].TerraceAreaSqft, 300);
  service.update('p2', { Notes: 'Follow up' });
  assert.equal(service.get('p2').data.ConfigDetails[0].CarpetAreaSqft, 2100);
});
