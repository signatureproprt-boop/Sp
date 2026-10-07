const {test,expect}=require('@playwright/test');
const path=require('node:path');
test('Sheet sync status reports completed writes and pending failures',async({page})=>{
 let posts=0;
 await page.route('**/sheet-requirement-sync.html',r=>r.fulfill({path:path.join(__dirname,'../sheet-requirement-sync.html'),contentType:'text/html'}));
 await page.route('**/api/sync/existing-sheet-requirement',r=>{
  if(r.request().method()==='GET')return r.fulfill({json:{ok:true,data:{configured:true,state:'SYNCED',updated:2,issues:0}}});
  posts++;return r.fulfill({status:503,json:{ok:false,state:'ERROR',message:'Sheet update pending'}});
 });
 await page.goto('/sheet-requirement-sync.html');
 await expect(page.locator('#status')).toContainText('SYNCED');
 await expect(page.locator('#status')).toContainText('Cells updated in last sync2');
 await page.getByRole('button',{name:'Sync saved requirements'}).click();
 await expect(page.getByRole('alert')).toHaveText('Sheet update pending');
 expect(posts).toBe(1);
 await expect(page.getByRole('button',{name:'Sync saved requirements'})).toBeEnabled();
});
