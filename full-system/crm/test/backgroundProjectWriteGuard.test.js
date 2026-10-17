'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {assertBackgroundProjectsUnchanged: guard} = require('../src/data/backgroundProjectWriteGuard');
function fixture() {
  const base = {BuilderProjects:[{ProjectID:'p',UpdatedAt:'old',BuilderName:''}],UploadedBrochureBatches:[{JobID:'j',ActorID:'worker:automation',Items:[{ItemID:'i',ProjectID:'p',Status:'reading'}]}]};
  const desired = structuredClone(base);
  desired.BuilderProjects[0].BuilderName='Printed builder';
  desired.UploadedBrochureBatches[0].Items[0].Status='saved';
  return {base,desired,remote:structuredClone(base)};
}
test('worker commit checks the actual remote project, including edits not yet polled locally',()=>{
  const f=fixture();assert.doesNotThrow(()=>guard(f.base,f.desired,f.remote));
  f.remote.BuilderProjects[0].BuilderName='Manual builder';
  assert.throws(()=>guard(f.base,f.desired,f.remote),{code:'BACKGROUND_PROJECT_CHANGED'});
});
test('deleted projects cannot be resurrected by a completed worker read',()=>{
  const f=fixture();f.remote.BuilderProjects=[];
  assert.throws(()=>guard(f.base,f.desired,f.remote),{code:'BACKGROUND_PROJECT_CHANGED'});
});
test('unrelated project edits and subsequent heartbeat writes do not block the worker',()=>{
  const f=fixture();f.remote.BuilderProjects.push({ProjectID:'other',BuilderName:'Manual edit'});
  assert.doesNotThrow(()=>guard(f.base,f.desired,f.remote));
  f.base.UploadedBrochureBatches[0].Items[0].Status='saved';f.remote.BuilderProjects=[];
  assert.doesNotThrow(()=>guard(f.base,f.desired,f.remote));
});
test('existing interactive project writes keep their existing merge behavior',()=>{
  const f=fixture();f.desired.UploadedBrochureBatches[0].ActorID='interactive-admin';f.remote.BuilderProjects=[];
  assert.doesNotThrow(()=>guard(f.base,f.desired,f.remote));
});
