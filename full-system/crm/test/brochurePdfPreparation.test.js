'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {preparePdfForAi}=require('../src/services/brochurePdfPreparationService');
test('small PDFs remain byte-identical; invalid inputs are rejected',async()=>{
  const source=Buffer.from('%PDF-1.7\noriginal');
  const result=await preparePdfForAi(source,{run:()=>{throw Error('must not run')}});
  assert.equal(result.buffer,source);assert.equal(result.optimized,false);
  await assert.rejects(preparePdfForAi(Buffer.from('not a PDF')),/not a PDF/);
});
test('large PDF uses all pages at 300 DPI and cleans temporary copies',async()=>{
  const source=Buffer.from('%PDF-1.7\n'+'x'.repeat(2000));let temp;
  const result=await preparePdfForAi(source,{maxBytes:1000,run:async(binary,args)=>{
    assert.equal(binary,'gs');assert.ok(args.includes('-dSAFER'));assert.ok(args.includes('-dColorImageResolution=300'));
    assert.ok(!args.some(x=>/FirstPage|LastPage/.test(x)));
    const input=args.at(-1);temp=path.dirname(input);assert.deepEqual(await fs.readFile(input),source);
    await fs.writeFile(args.find(x=>x.startsWith('-sOutputFile=')).split('=').slice(1).join('='),Buffer.from('%PDF-1.7\nsmaller complete copy'));
  }});
  assert.equal(result.optimized,true);assert.equal(result.sourceBytes,source.length);assert.equal(result.buffer.length<1000,true);
  await assert.rejects(fs.stat(temp),{code:'ENOENT'});
});
test('preparation failure is explicit and leaves no temporary files',async()=>{
  let temp;await assert.rejects(preparePdfForAi(Buffer.from('%PDF-1.7\n'+'x'.repeat(2000)),{maxBytes:1000,run:async(_binary,args)=>{
    temp=path.dirname(args.at(-1));throw Object.assign(Error('deadline'),{killed:true});
  }}),/timed out/);await assert.rejects(fs.stat(temp),{code:'ENOENT'});
});
test('240 DPI fallback reads the same complete source if the 300 DPI copy remains too large',async()=>{
  let calls=0;
  const result=await preparePdfForAi(Buffer.from('%PDF-1.7\n'+'x'.repeat(2000)),{maxBytes:1000,run:async(_binary,args)=>{
    calls++;assert.ok(args.includes('-dColorImageResolution='+(calls===1?300:240)));
    assert.ok(!args.some(x=>/FirstPage|LastPage/.test(x)));
    const output=args.find(x=>x.startsWith('-sOutputFile=')).slice('-sOutputFile='.length);
    await fs.writeFile(output,Buffer.from('%PDF-1.7\n'+'x'.repeat(calls===1?1500:500)));
  }});
  assert.equal(calls,2);assert.equal(result.resolution,240);assert.ok(result.buffer.length<1000);
});
test('visual preparation preserves numeric page order and rejects missing pages',async()=>{
  const {renderPdfForAi}=require('../src/services/brochurePdfPreparationService');
  let temp;
  const fakeRun=async(binary,args)=>{
    assert.equal(binary,'pdftoppm');assert.ok(args.includes('2400'));
    temp=path.dirname(args.at(-1));
    for(let n=12;n>=1;n--)await fs.writeFile(path.join(temp,'page-'+n+'.jpg'),Buffer.from([255,216,n,255,217]));
  };
  const pages=await renderPdfForAi(Buffer.from('%PDF-1.7'),12,{run:fakeRun});
  assert.deepEqual(pages.map(p=>Buffer.from(p.data,'base64')[2]),Array.from({length:12},(_,i)=>i+1));
  await assert.rejects(fs.stat(temp),{code:'ENOENT'});
  await assert.rejects(renderPdfForAi(Buffer.from('%PDF-1.7'),13,{run:fakeRun}),/incomplete/);
  await assert.rejects(fs.stat(temp),{code:'ENOENT'});
  assert.equal(await renderPdfForAi(Buffer.from('%PDF-1.7'),31,{run:()=>{throw Error('must not run')}}),null);
});
