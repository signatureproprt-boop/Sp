const test=require('node:test'),assert=require('node:assert/strict');
const share=require('../shortlist-share'),{ShortlistServiceV2}=require('../src/services/shortlistServiceV2');
test('share keeps paired BHK and area types, safe links, and excludes internal notes',()=>{
const text=share.message([{Notes:'private discount',Property:{ConfigDetails:[{BHK:3,CarpetAreaSqft:1000,SuperBuiltUpAreaSqft:1800},{BHK:4,SuperBuiltUpAreaSqft:2500}],MediaLinks:{brochures:['/brochure/abc','javascript:alert(1)']}}}],{},'https://crm.example');
assert.match(text,/3 BHK · Carpet: 1000 sqft · Super built-up: 1800 sqft/);assert.match(text,/4 BHK · Super built-up: 2500 sqft/);assert.doesNotMatch(text,/Carpet: 2500|private discount|javascript:/);assert.match(text,/https:\/\/crm.example\/brochure\/abc/);
});
test('generic area is not carpet and WhatsApp takes priority over primary phone',()=>{
const p=new ShortlistServiceV2({})._propertySnapshot({Area:1500,BHK:3});assert.equal(p.CarpetArea,null);assert.match(share.message([{Property:p}],{},'https://crm.example'),/Area: 1500 sqft \(area type not specified\)/);assert.equal(share.phone({WhatsApp:'9876543210',PrimaryMobile:'9123456789'}),'919876543210');assert.equal(share.phone({}),'');
});
test('existing builder shortlist refreshes project configurations while retaining selected brochure',()=>{
const project={ProjectName:'Updated',ConfigDetails:[{BHK:3,CarpetAreaSqft:1234}]};const svc=new ShortlistServiceV2({read:()=>({}),find:c=>c==='BuilderProjects'?project:null});const view=svc.buildView({IsManual:true,BuilderProjectID:'P1',ManualProperty:{Title:'Old',MediaLinks:{brochures:['https://crm.example/selected']}}});assert.equal(view.Property.Title,'Updated');assert.equal(view.Property.ConfigDetails[0].CarpetAreaSqft,1234);assert.deepEqual(view.Property.MediaLinks.brochures,['https://crm.example/selected']);
});
