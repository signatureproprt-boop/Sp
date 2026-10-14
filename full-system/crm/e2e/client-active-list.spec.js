const {test,expect}=require('@playwright/test');
const path=require('node:path');
test('Clients opens active view and Lost is requested explicitly',async({page})=>{
  const queries=[];
  await page.route('**/clients',r=>r.fulfill({path:path.join(__dirname,'../client-workspace-hub.html'),contentType:'text/html'}));
  await page.route('**/client-workspace-hub.js',r=>r.fulfill({path:path.join(__dirname,'../client-workspace-hub.js'),contentType:'application/javascript'}));
  await page.route('**/api/**',async r=>{
    const u=new URL(r.request().url());
    if(u.pathname==='/api/v2/clients/query'){
      queries.push(u.searchParams);
      const lost=u.searchParams.get('status')==='Lost';
      await r.fulfill({json:{ok:true,data:[{LeadID:lost?'L2':'L1',ClientName:lost?'Lost QA':'Active QA',ClientStatus:lost?'Lost':'New'}],totalCount:1,pagination:{page:1,total:1,totalPages:1},summary:{}}});
    }else await r.fulfill({json:{ok:true,data:[]}});
  });
  await page.goto('/clients');
  await expect(page.locator('#grid')).toContainText('Active QA');
  expect(queries.at(-1).get('excludeLost')).toBe('true');
  await expect(page.locator('#status option:checked')).toHaveText('Active Clients');
  await page.getByRole('button',{name:'List View',exact:true}).click();
  await expect(page.getByRole('table',{name:'Clients list'})).toContainText('Active QA');
  await expect(page.getByRole('button',{name:'List View',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Follow-up',exact:true}).click();
  await expect(page.locator('#status')).toHaveValue('Follow-up');
  await expect.poll(()=>queries.at(-1).get('status')).toBe('Follow-up');
  await page.getByRole('button',{name:'Site Visit',exact:true}).click();
  await expect(page.locator('#status')).toHaveValue('Site Visit');
  await expect.poll(()=>queries.at(-1).get('status')).toBe('Site Visit');
  await page.getByRole('button',{name:'Card View',exact:true}).click();
  await expect(page.locator('#grid article')).toContainText('Active QA');
  await page.locator('#status').selectOption('Lost');
  await expect(page.locator('#grid')).toContainText('Lost QA');
  expect(queries.at(-1).get('status')).toBe('Lost');
  expect(queries.at(-1).has('excludeLost')).toBe(false);
  await page.locator('#status').selectOption('');
  await expect(page.locator('#grid')).toContainText('Active QA');
  await expect(page.locator('#grid')).not.toContainText('Lost QA');
});
