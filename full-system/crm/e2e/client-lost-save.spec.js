const { test, expect } = require('@playwright/test');
const path = require('node:path');

test('client Lost save with labelled BHK preserves identity and survives refresh', async ({page}) => {
  let lead = {LeadID:'L1',ClientName:'QA Client',PrimaryMobile:'9876543210',ClientStatus:'New',ClientLifecycle:'Prospect',Source:'Manual',RequirementType:'Purchase',PropertyType:'Residential',BHK:'3 BHK'};
  const writes = [];
  await page.route('**/client-workspace.html?*', r => r.fulfill({path:path.join(__dirname,'../client-workspace.html'),contentType:'text/html'}));
  await page.route('**/api/**', async r => {
    const req = r.request(), p = new URL(req.url()).pathname; let result = {ok:true,data:[]};
    if (p.endsWith('/workspace')) result = {ok:true,data:{lead,requirements:[],transactions:[],activities:[],timeline:[],followUps:[]}};
    else if (p === '/api/v2/clients/L1' && req.method() === 'PATCH') {
      writes.push(req.postDataJSON()); lead = {...lead,...writes.at(-1)}; result = {ok:true,data:lead};
    }
    await r.fulfill({json:result});
  });
  await page.goto('/client-workspace.html?id=L1');
  await page.getByRole('combobox',{name:'Lead Status',exact:true}).selectOption('Lost');
  await page.getByRole('textbox',{name:'Lost Reason *',exact:true}).fill('Other');
  await page.getByRole('button',{name:'Save Client Details',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Lead Status',exact:true})).toHaveValue('Lost');
  await expect(page.getByRole('button',{name:'Save Client Details',exact:true})).toBeEnabled();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ClientStatus:'Lost',LostReason:'Other',PrimaryMobile:'9876543210',BHK:'3 BHK'});
  await page.reload();
  await expect(page.getByRole('combobox',{name:'Lead Status',exact:true})).toHaveValue('Lost');
  await expect(page.getByRole('textbox',{name:'BHK',exact:true})).toHaveValue('3 BHK');
  await expect(page.getByRole('textbox',{name:'Client Name',exact:true})).toHaveValue('QA Client');
});
