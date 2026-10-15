const {test,expect}=require('@playwright/test');
test('client requirement prepares the selected brochure, opens a draft and requires manual send confirmation',async({page})=>{
 const lead={LeadID:'L1',ClientName:'QA Client',PrimaryMobile:'9876543210',ClientStatus:'New'};
 const requirement={RequirementID:'R1',LeadID:'L1',TransactionType:'Purchase',Category:'Residential',BHKMin:3,CarpetAreaMin:1000,CarpetAreaMax:1500,RequirementStatus:'Active'};
 const project={ProjectID:'P1',ProjectName:'Vesu Heights',Category:'Residential',ConfigDetails:[{BHK:3,CarpetAreaSqft:1200,SuperBuiltUpAreaSqft:2000},{BHK:4,CarpetAreaSqft:1600}],Brochures:[{Name:'First.pdf',DriveFileID:'first',verified:true,downloadStatus:'downloaded'},{Name:'Chosen.pdf',DriveFileID:'chosen',verified:true,downloadStatus:'downloaded'}]};
 let prepared=null,confirmed=null;const shortlist=[];
 await page.route('**/client-workspace.html?*',r=>r.fulfill({path:require('node:path').join(__dirname,'../client-workspace.html'),contentType:'text/html'}));
 await page.route('**/client-brochures.js',r=>r.fulfill({path:require('node:path').join(__dirname,'../client-brochures.js'),contentType:'application/javascript'}));
 await page.route('**/api/**',async r=>{const req=r.request(),p=new URL(req.url()).pathname;let result={ok:true,data:[]};
  if(p.endsWith('/workspace'))result={ok:true,data:{lead,requirements:[requirement],transactions:[],followUps:[],activities:[],timeline:[]}};
  else if(p==='/api/v2/builder-projects'){const query=new URL(req.url()).searchParams;expect(query.get('category')).toBe('Residential');expect(query.get('bhk')).toBe('3 BHK');expect(query.get('carpetMin')).toBe('1000');expect(query.get('carpetMax')).toBe('1500');result={ok:true,data:[project]};}
  else if(p==='/api/v2/shortlist/R1')result={ok:true,data:shortlist};
  else if(p.endsWith('/brochure-shares')){prepared=req.postDataJSON();shortlist.push({PropertyID:'BUILDER-P1',Property:{Title:'Vesu Heights',MediaLinks:{brochures:['https://crm.example/selected.pdf']}}});result={ok:true,data:{ShareID:'share-1',recipientPhone:'919876543210',url:'https://crm.example/selected.pdf'}};}
  else if(p.endsWith('/brochure-shares/share-1')){confirmed=req.postDataJSON();result={ok:true,data:{ShareID:'share-1'}};}
  await r.fulfill({json:result});
 });
 await page.goto('/client-workspace.html?id=L1');await page.getByRole('button',{name:'⭐ Shortlist & Brochures',exact:true}).click();
 await page.getByRole('button',{name:'Chosen.pdf',exact:true}).click();await page.getByLabel('Unit configuration',{exact:true}).selectOption('0');await page.getByRole('button',{name:'Add to shortlist & prepare brochure',exact:true}).click();
 await expect(page.getByRole('link',{name:'Open WhatsApp',exact:true})).toBeVisible();expect(prepared).toMatchObject({leadId:'L1',requirementId:'R1',brochureFileKey:'chosen',selectedConfigIndex:0});expect(prepared.transactionId).toBeUndefined();
 const draft=await page.getByRole('link',{name:'Open WhatsApp',exact:true}).getAttribute('href');expect(draft).toContain('wa.me/919876543210');expect(decodeURIComponent(draft)).toContain('selected.pdf');expect(decodeURIComponent(draft)).toContain('3 BHK');expect(decodeURIComponent(draft)).not.toContain('4 BHK');await expect(page.getByRole('img',{name:/Signature Properties — Vesu Heights/})).toBeVisible();await expect(page.getByRole('link',{name:'Download branded card'})).toBeVisible();expect(confirmed).toBeNull();
 await page.getByRole('button',{name:'Confirm sent & save follow-up',exact:true}).click();expect(confirmed).toBeNull();
 await page.locator('#client-brochure-sent').check();await page.locator('#client-brochure-followup').fill('2099-01-01');await page.getByRole('button',{name:'Confirm sent & save follow-up',exact:true}).click();await expect(page.getByRole('status')).toContainText('Sent confirmation saved');expect(confirmed).toEqual({sent:true,followUpAt:'2099-01-01T10:00:00+05:30'});
 await expect(page.locator('#client-brochure-error')).toBeEmpty();
});
