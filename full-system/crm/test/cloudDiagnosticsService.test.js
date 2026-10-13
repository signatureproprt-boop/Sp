'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCloudDiagnostics,reasonFor,summarizeEntry,safeMongo}=require('../src/services/cloudDiagnosticsService');
test('cloud diagnostics use fixed read-only resources, cache concurrent checks and strip secrets',async()=>{
 const calls=[]; const service=createCloudDiagnostics({env:{K_SERVICE:'signature-realty-crm'},now:()=>1800000000000,request:async o=>{
  calls.push(o);
  if(o.method==='GET')return {data:{latestReadyRevision:'projects/p/locations/r/services/s/revisions/rev1',terminalCondition:{state:'CONDITION_SUCCEEDED'},template:{serviceAccount:'runtime@example.com',containers:[{env:[{value:'SECRET'}],resources:{cpuIdle:true}}]}}};
  return {data:{entries:[{timestamp:'today',textPayload:'[mongoStore] snapshot write attempt failed: {"message":"you are over your space quota password=SECRET"}',resource:{labels:{revision_name:'rev1'}}},{textPayload:'[perf] {"totalMs":1250,"statusCode":200,"endpoint":"/private-client/secret"}'}]}};
 }});
 const [a,b]=await Promise.all([service.load(),service.load()]); assert.equal(calls.length,2);assert.deepEqual(a,b);assert.equal(a.state,'CONNECTED');assert.equal(a.logs.entries[0].reason,'DATABASE_QUOTA');assert.equal(a.logs.entries[1].totalMs,1250);
 assert.ok(!JSON.stringify(a).includes('SECRET')); assert.ok(!JSON.stringify(a).includes('private-client'));
 assert.equal(calls[0].method,'GET'); assert.equal(calls[1].url,'https://logging.googleapis.com/v2/entries:list');assert.equal(calls[1].data.pageSize,25);assert.match(calls[1].data.filter,/signature-realty-crm/);await service.load();assert.equal(calls.length,2);
});
test('missing runtime permissions are explicit and never expose provider payloads',async()=>{
 const service=createCloudDiagnostics({request:async()=>{throw {response:{status:403,data:{secret:'private'}}}}});const d=await service.load();assert.equal(d.service.state,'PERMISSION_DENIED');assert.equal(d.logs.permission,'logging.logEntries.list');assert.ok(!JSON.stringify(d).includes('private'));
});
test('Google API disabled and insufficient scopes differ from workbook sharing failures',()=>{
 assert.equal(reasonFor({response:{status:403,data:{error:{details:[{reason:'SERVICE_DISABLED'}]}}}}),'API_DISABLED');
 assert.equal(reasonFor({response:{status:403,data:{error:{details:[{reason:'ACCESS_TOKEN_SCOPE_INSUFFICIENT'}]}}}}),'OAUTH_SCOPE');
 assert.equal(reasonFor({response:{status:403}}),'PERMISSION_DENIED');
 assert.deepEqual(safeMongo({lastError:'quota with SECRET',cacheSize:1024}).lastFailure,'UNAVAILABLE');
 assert.ok(!JSON.stringify(summarizeEntry({textPayload:'[crm-sheet-report] {"message":"client phone SECRET", "stage":"WORKBOOK_METADATA","reason":"GOOGLE_ACCESS"}'})).includes('SECRET'));
});
