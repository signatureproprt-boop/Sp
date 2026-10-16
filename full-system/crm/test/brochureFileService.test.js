'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { uploadBrochure } = require('../src/services/brochureFileService');
const API = 'https://generativelanguage.googleapis.com';

test('Files API uploads original bytes once, polls readiness and deletes its file', async () => {
  const old = global.fetch, requests = [];
  const file = {name:'files/test123',uri:API+'/v1beta/files/test123',mimeType:'application/pdf',state:'ACTIVE'};
  const pdf = Buffer.from('%PDF original bytes');
  try {
    global.fetch = async (url, options) => {
      requests.push({url,options});
      if (requests.length === 1) return {ok:true,headers:new Headers({'x-goog-upload-url':API+'/upload/session123'})};
      if (requests.length === 2) return {ok:true,json:async()=>({file:{...file,state:'PROCESSING'}})};
      return {ok:true,json:async()=>file};
    };
    const uploaded = await uploadBrochure(pdf, 'test-key', AbortSignal.timeout(5000));
    assert.equal(requests.length,3);
    assert.deepEqual(requests[1].options.body,pdf);
    assert.equal(requests[0].options.headers['X-Goog-Upload-Header-Content-Length'],String(pdf.length));
    assert.equal(uploaded.part.file_data.file_uri,file.uri);
    assert.equal(requests[2].url,file.uri);
    await uploaded.dispose();
    assert.equal(requests[3].options.method,'DELETE');
  } finally {global.fetch=old;}
});

test('untrusted upload destinations are rejected before transmitting PDF bytes', async () => {
  const old=global.fetch;let calls=0;
  try {
    global.fetch=async()=>{calls++;return {ok:true,headers:new Headers({'x-goog-upload-url':'https://attacker.example/upload'})};};
    await assert.rejects(uploadBrochure(Buffer.from('%PDF secret'),'test-key',AbortSignal.timeout(5000)),/invalid upload destination/);
    assert.equal(calls,1);
  } finally {global.fetch=old;}
});

test('file processing failure cleans up the uploaded file and never returns a document part', async () => {
  const old=global.fetch;let calls=0,deleted=false;
  try {
    global.fetch=async(_url,options)=>{
      calls++;
      if(calls===1)return {ok:true,headers:new Headers({'x-goog-upload-url':API+'/upload/session'})};
      if(options.method==='DELETE'){deleted=true;return {ok:true};}
      return {ok:true,json:async()=>({file:{name:'files/test123',state:'FAILED'}})};
    };
    await assert.rejects(uploadBrochure(Buffer.from('%PDF'),'test-key',AbortSignal.timeout(5000)),/not ready/);
    assert.equal(deleted,true);
  } finally {global.fetch=old;}
});
