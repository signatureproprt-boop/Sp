const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup({folderAccess=true,writeAllowed=true}={}) {
 const requests=[];
 const google = {
  auth: {
   GoogleAuth: class {
    async getProjectId() { return 'project'; }
    async getClient() {
     return { request: async o => {
      requests.push(o);
      if (o.method === 'POST' && !writeAllowed) throw Error('private provider error');
      return { data: o.method === 'GET' ? {payload:{data:Buffer.from('secret-token').toString('base64')}} : {name:'version/2'} };
     }};
    }
   },
   OAuth2: class {
    constructor(){this.credentials={};}
    setCredentials(v){this.credentials=v;}
    async getAccessToken(){this.credentials.expiry_date=123456;return {token:'access'};}
   }
  },
  drive:()=>({files:{get:async()=>{if(!folderAccess)throw Error('private provider error');return {data:{id:'folder'}};}}})
 };
 const context={module:{exports:{}},require:()=>({google}),Buffer,Date,process:{env:{}}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/../src/services/driveConnectionService.js','utf8'),context);
 return {...context.module.exports,requests};
}
const env={SIG_REALTY_GOOGLE_CLIENT_ID:'id',SIG_REALTY_GOOGLE_CLIENT_SECRET:'secret',BUILDER_PROJECTS_DRIVE_FOLDER_ID:'folder'};
const payload={refresh_token:'new-token',scope:'https://www.googleapis.com/auth/drive'};
test('reconnect verifies folder and writes only token secret without returning credentials',async()=>{
 const x=setup();const out=await x.saveDriveReconnect(payload,{...env});
 assert.equal(JSON.stringify(out),'{"connected":true}');assert.equal(x.requests.length,1);
 assert.equal(x.requests[0].url,'https://secretmanager.googleapis.com/v1/projects/project/secrets/sig-realty-google-refresh-token:addVersion');
 assert.equal(x.requests[0].data.payload.data,Buffer.from('new-token').toString('base64'));
});
test('wrong account, missing refresh token and unapproved Drive scope cannot rotate secret',async()=>{
 const x=setup({folderAccess:false});await assert.rejects(x.saveDriveReconnect(payload,env),/cannot access/);assert.equal(x.requests.length,0);
 await assert.rejects(x.saveDriveReconnect({},env),/new Drive connection/);
 await assert.rejects(x.saveDriveReconnect({refresh_token:'token',scope:'openid'},env),/permission was not approved/);assert.equal(x.requests.length,0);
});
test('failed persistence exposes setup guidance without provider secrets',async()=>{
 const x=setup({writeAllowed:false});await assert.rejects(x.saveDriveReconnect(payload,env),e=>e.message.includes('version-write permission')&&!e.message.includes('private'));
});
test('running instances refresh through latest secret version',async()=>{
 const x=setup();const result=await x.refreshManagedDriveToken(env);assert.equal(result.access_token,'access');assert.match(x.requests[0].url,/versions\/latest:access$/);
});
test('scripts compile and reconnect state is bound to initiating admin',()=>{
 new vm.Script(fs.readFileSync(__dirname+'/../server.js','utf8'));
 for(const name of ['admin.html','login.html'])for(const m of fs.readFileSync(__dirname+'/../'+name,'utf8').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
 const source=fs.readFileSync(__dirname+'/server.js','utf8');assert.match(source,/user.UserID !== expectedUser/);assert.match(source,/String\(user.Role\).toUpperCase\(\) !== 'ADMIN'/);
});
