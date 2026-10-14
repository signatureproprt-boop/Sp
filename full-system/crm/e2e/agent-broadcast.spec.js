const {test,expect}=require('@playwright/test');
const path=require('node:path');
test('broadcast previews only requirement details and prepares selected agent drafts without auto opening WhatsApp',async({page})=>{
 const writes=[];
 const requirement={RequirementID:'R1',LeadID:'L1',TransactionType:'Purchase',Category:'Residential',SubCategory:'Flat',RequirementStatus:'Active',Location1:'Vesu',BHK:3,BudgetMax:7000000};
 const share={ShareID:'SH1',Token:'safe-token',BrokerName:'QA Agent',BrokerPhone:'9876543211',Status:'Open',ExpiresAt:'2099-01-01'};
 await page.route('**/client-workspace.html?*',r=>r.fulfill({path:path.join(__dirname,'../client-workspace.html'),contentType:'text/html'}));
 await page.route('**/client-agent-broadcast.js',r=>r.fulfill({path:path.join(__dirname,'../client-agent-broadcast.js'),contentType:'application/javascript'}));
 await page.route('**/api/**',async r=>{
  const q=r.request(),p=new URL(q.url()).pathname;let result={ok:true,data:[]};
  if(p.endsWith('/workspace'))result={ok:true,data:{lead:{LeadID:'L1',ClientName:'PRIVATE CLIENT',PrimaryMobile:'9876543210',ClientStatus:'New'},requirements:[requirement],transactions:[],activities:[],followUps:[]}};
  if(p==='/api/v2/broker-network')result={ok:true,data:[{NetworkBrokerID:'B1',Name:'QA Agent',Phone:'9876543211',Active:true}]};
  if(q.method()==='POST'){
   writes.push({path:p,body:q.postDataJSON()});
   if(p.endsWith('/network-share')){share.Message=q.postDataJSON().message;result={ok:true,data:{shares:[share]}};}
   if(p.endsWith('/sent'))result={ok:true,data:{...share,SentAt:'2026-10-14T00:00:00Z',DeliveryStatus:'ManuallyConfirmed'}};
  }
  await r.fulfill({json:result});
 });
 await page.goto('/client-workspace.html?id=L1');
 await page.getByRole('button',{name:'👥 Broadcast to Agents',exact:true}).click();
 await expect(page.locator('#net-preview')).toContainText('Vesu');
 await expect(page.locator('#net-preview')).not.toContainText('PRIVATE CLIENT');
 await expect(page.locator('#net-preview')).not.toContainText('9876543210');
 await expect(page.getByRole('checkbox',{name:'QA Agent',exact:true})).not.toBeChecked();
 await page.getByRole('checkbox',{name:'QA Agent',exact:true}).check();
 await page.getByRole('button',{name:'Prepare WhatsApp Drafts',exact:true}).click();
 const link=page.getByRole('link',{name:'Open WhatsApp Draft',exact:true});await expect(link).toBeVisible();
 const href=await link.getAttribute('href');expect(href).toContain('wa.me/919876543211');expect(decodeURIComponent(href)).toContain('Vesu');expect(decodeURIComponent(href)).not.toContain('PRIVATE CLIENT');expect(decodeURIComponent(href)).not.toContain('9876543210');
 expect(writes[0].body.brokerIds).toEqual(['B1']);expect(writes[0].body.clientRequestId).toBeTruthy();expect(page.context().pages()).toHaveLength(1);
 await page.getByRole('button',{name:'I sent this on WhatsApp',exact:true}).click();await expect(page.locator('#net-links-out')).toContainText('Sent — manually confirmed');
 expect(writes.at(-1).path).toBe('/api/v2/network-shares/SH1/sent');
});
