const {test,expect}=require('@playwright/test');const path=require('node:path');
test('shortlist share reviews fresh configurations and WhatsApp recipient before opening a draft',async({page})=>{
 const lead={LeadID:'L1',ClientName:'QA Client',PrimaryMobile:'9123456789',WhatsApp:'9876543210'};
 const requirement={RequirementID:'R1',LeadID:'L1',TransactionType:'Purchase',Category:'Residential',RequirementStatus:'Active'};
 let reads=0;
 await page.route('**/client-workspace.html?*',r=>r.fulfill({path:path.join(__dirname,'../client-workspace.html'),contentType:'text/html'}));
 await page.route('**/shortlist-share.js',r=>r.fulfill({path:path.join(__dirname,'../shortlist-share.js'),contentType:'application/javascript'}));
 await page.route('**/api/**',async r=>{const p=new URL(r.request().url()).pathname;let json={ok:true,data:[]};
 if(p.endsWith('/workspace'))json={ok:true,data:{lead,requirements:[requirement],transactions:[],followUps:[],activities:[],timeline:[]}};
 if(p==='/api/v2/shortlist/R1'){reads++;json={ok:true,data:[{PropertyID:'P1',Notes:'Private discount',Property:{Title:reads>1?'Updated project':'Old project',ConfigDetails:[{BHK:3,CarpetAreaSqft:1200,SuperBuiltUpAreaSqft:2000}],MediaLinks:{brochures:['https://crm.example/selected.pdf']}}}]};}
 await r.fulfill({json});});
 await page.goto('/client-workspace.html?id=L1');
 await page.getByTestId('req-shortlist-R1').click();await page.getByTestId('sl-whatsapp-R1').click();
 const preview=page.getByRole('dialog',{name:'Review shortlist message'});await expect(preview).toBeVisible();
 const text=page.getByRole('textbox',{name:'Shortlist message'});
 await expect(text).toHaveValue(/Updated project/);await expect(text).toHaveValue(/3 BHK · Carpet: 1200 sqft · Super built-up: 2000 sqft/);await expect(text).not.toHaveValue(/Private discount/);
 const link=preview.getByRole('link',{name:'Open WhatsApp'});expect(await link.getAttribute('href')).toContain('wa.me/919876543210');
 await text.fill('Reviewed message');expect(decodeURIComponent(await link.getAttribute('href'))).toContain('Reviewed message');expect(page.context().pages()).toHaveLength(1);
});
