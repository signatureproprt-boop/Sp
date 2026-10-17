'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function setup(errors) {
  let attempts=0, closes=0, flushes=0;
  const store={initMongo:async()=>{const e=errors[attempts++];if(e)throw e;},close:async()=>{closes++;},flush:async()=>{flushes++;}};
  const context={module:{exports:{}},console:{log(){},warn(){},error(){}},process:{argv:['node','worker','--check-storage'],env:{STORAGE_MODE:'mongo',MONGO_URL:'fixture'}},require:name=>{
    if(name.endsWith('mongoStore'))return store;
    if(name==='node:timers/promises')return {setTimeout:async()=>{}};
    return {};
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../scripts/residentialBrochureWorker.js'),'utf8'),context);
  return {main:context.module.exports.main,attempts:()=>attempts,closes:()=>closes,flushes:()=>flushes};
}
const timeout=()=>Object.assign(Error('fixture timeout'),{name:'MongoNetworkTimeoutError'});
test('worker closes Mongo clients even when initial snapshot loading never succeeds',async()=>{
  const s=setup([timeout(),timeout(),timeout()]);await assert.rejects(s.main(),/fixture timeout/);
  assert.equal(s.attempts(),3);assert.equal(s.closes(),3);assert.equal(s.flushes(),1);
});
test('transient Mongo startup can recover without leaving the failed connection open',async()=>{
  const s=setup([timeout()]);await s.main();assert.equal(s.attempts(),2);assert.equal(s.closes(),2);
});
test('authentication/configuration errors do not trigger repeated startup attempts',async()=>{
  const s=setup([Object.assign(Error('authentication failed'),{name:'MongoServerError'})]);
  await assert.rejects(s.main(),/authentication failed/);assert.equal(s.attempts(),1);assert.equal(s.closes(),1);
});
