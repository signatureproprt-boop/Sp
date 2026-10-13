'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { VastuSourceService } = require('../src/services/vastuSourceService');
const { VastuAnalysisService } = require('../src/services/vastuAnalysisService');

test('stores a source by checksum and analysis only accepts the matching tenant/project/hash', async () => {
  const rows = { VastuSources:[],BuilderProjects:[{ProjectID:'P1',ProjectName:'Project',CompanyID:'C1',BrokerageID:'B1'}],VastuAnalyses:[] };
  const repository = {
    createId:() => 'VSRC-1',
    create:(key,row) => { rows[key].push(row); return row; },
    find:(key,field,value) => rows[key]?.find((row) => row[field] === value) || null,
    list:(key) => rows[key] || []
  };
  const saved = [];
  const service = new VastuSourceService(repository,{ putObject:async (path,buffer,type) => saved.push({path,buffer,type}) });
  const bytes = Buffer.from('%PDF-1.7\nSource content');
  const actor = {userId:'U1',companyId:'C1',brokerageId:'B1'};
  const result = await service.upload({projectId:'P1',filename:'floorplan.pdf',dataBase64:bytes.toString('base64')},actor);
  assert.equal(result.Sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(saved[0].type,'application/pdf');
  assert.equal((await service.upload({projectId:'P1',filename:'copy.pdf',dataBase64:bytes.toString('base64')},actor)).SourceID,result.SourceID);
  assert.equal(saved.length,1);
  assert.equal(service.get(result.SourceID,actor).ProjectID,'P1');
  assert.equal(service.get(result.SourceID,{...actor,companyId:'C2'}),null);
  const input = {projectId:'P1',propertyType:'residential',spaceType:'Flat',layoutCount:1,
    source:{sha256:result.Sha256,sourceId:result.SourceID,page:1,width:800,height:800},
    north:{centerX:.5,centerY:.5,tipX:.5,tipY:.4},
    layouts:[{x:0,y:0,w:1,h:1,confirmed:true,rooms:[{type:'Entrance',x:.5,y:.1,reviewStatus:'accepted'}]}]};
  assert.equal(new VastuAnalysisService(repository).saveDraft(input,actor).Source.SourceID,result.SourceID);
  assert.throws(() => new VastuAnalysisService(repository).saveDraft({...input,source:{...input.source,sha256:'b'.repeat(64)}},actor),/does not match/);
  rows.VastuSources[0].ProjectID = 'OTHER';
  assert.throws(() => new VastuAnalysisService(repository).saveDraft(input,actor),/does not match/);
  await assert.rejects(service.upload({projectId:'P1',filename:'bad.pdf',dataBase64:Buffer.from('bad').toString('base64')},actor),/Only PDF/);
});
