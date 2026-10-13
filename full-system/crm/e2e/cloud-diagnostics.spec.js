const {test,expect}=require('@playwright/test');
test('Admin cloud panel displays safe cloud diagnostics and precise Sheet issue',async({page})=>{
 await page.route('**/admin',r=>r.fulfill({path:require('node:path').join(__dirname,'../admin.html'),contentType:'text/html'}));
 await page.route('**/api/**',r=>r.fulfill({json:{ok:true,data:{}}}));
 await page.route('**/api/admin/cloud-diagnostics',r=>r.fulfill({json:{ok:true,data:{project:'signature-509218',region:'asia-south1',serviceName:'signature-realty-crm',currentRevision:'rev-qa',service:{state:'CONNECTED',revision:'rev-qa'},logs:{state:'CONNECTED',entries:[{timestamp:'2026-10-13',component:'Mongo save',event:'Save failed',reason:'DATABASE_QUOTA'}]},mongo:{initialized:true,pendingWrites:2},report:{state:'ERROR',reason:'API_DISABLED',message:'Enable Google Sheets API'}}}}));
 await page.goto('/admin');await page.getByRole('button',{name:'Check Google Cloud connection',exact:true}).click();
 await expect(page.locator('#cloudState')).toHaveText('Cloud Run: CONNECTED | Logs: CONNECTED');
 await expect(page.locator('#cloudDetails')).toContainText('Pending saves 2');await expect(page.locator('#cloudDetails')).toContainText('API_DISABLED');await expect(page.locator('#cloudEvents')).toContainText('DATABASE_QUOTA');
});
