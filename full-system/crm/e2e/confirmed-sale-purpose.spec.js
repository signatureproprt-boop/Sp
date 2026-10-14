const { test, expect } = require('@playwright/test');
const path = require('node:path');

for (const source of ['manual', 'sheet']) {
  test(`${source} Sale requirement keeps confirmed scope over old Purchase preferences`, async ({page}) => {
    const lead = {LeadID:'L1',ClientName:'QA Client',PrimaryMobile:'9876543210',RequirementType:'Purchase',Category:'Residential',SubCategory:'Flat',BudgetMax:7000000,
      SheetBasicRequirements:source === 'sheet' ? [{SourceTab:'Comm',SourceRow:2,TransactionType:'Sale',Category:'Commercial',SubCategory:'Office',BudgetMax:2500}] : []};
    const requirements = []; const writes = [];
    await page.route('**/client-workspace.html?*', r => r.fulfill({path:path.join(__dirname,'../client-workspace.html'),contentType:'text/html'}));
    await page.route('**/api/**', async r => {
      const req = r.request(), url = new URL(req.url()); let result = {ok:true,data:[]};
      if (url.pathname.endsWith('/workspace')) result = {ok:true,data:{lead,requirements,transactions:[],timeline:[],activities:[],followUps:[]}};
      else if (url.pathname.endsWith('/subcategories')) result = {ok:true,data:['Office']};
      else if (url.pathname.endsWith('/form-config')) result = {ok:true,data:{fields:[{FieldKey:'BudgetMax',FieldLabel:'Budget Max',FieldType:'Number',Active:true}]}};
      else if (url.pathname === '/api/v2/clients/L1/requirements') {
        writes.push(req.postDataJSON()); requirements.push({...writes[0],RequirementID:'R1',LeadID:'L1'}); result = {ok:true,data:requirements[0]};
      }
      await r.fulfill({json:result});
    });
    await page.goto('/client-workspace.html?id=L1');
    if (source === 'sheet') await page.getByRole('button',{name:'Use Sheet Details',exact:true}).click();
    else {
      await page.getByRole('button',{name:'＋ Add Another Requirement',exact:true}).click();
      await page.locator('#need-txn-type').selectOption('Sale');
      await page.locator('#need-category').selectOption('Commercial');
      await page.locator('#need-subcategory').selectOption('Office');
    }
    await expect(page.locator('#need-fld-BudgetMax')).toBeVisible();
    await expect(page.locator('#need-txn-type')).toHaveValue('Sale');
    await page.getByRole('button',{name:'Add Requirement',exact:true}).click();
    await expect(page.locator('#edit-requirements-list')).toContainText('Sale · Commercial');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({TransactionType:'Sale',Category:'Commercial',SubCategory:'Office',PropertyType:'Office'});
    expect(writes[0].TransactionID).toBeUndefined();
  });
}
