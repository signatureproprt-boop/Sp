const { test, expect } = require('@playwright/test');

test('client form keeps identity and edits a dynamic requirement without a transaction', async ({page}) => {
  let lead = {LeadID: 'L1', ClientName: 'Sample Client', PrimaryMobile: '9876543210', ClientStatus: 'New', ClientLifecycle: 'Prospect', Source: 'Manual', BudgetMax: 7000000};
  const requirements = [];
  const writes = [];
  await page.route('**/client-workspace.html?*', route => route.fulfill({path: require('path').join(__dirname, '../client-workspace.html'), contentType: 'text/html'}));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), body = req.postDataJSON() || {};
    let response = {ok: true, data: []};
    if (req.method() !== 'GET') writes.push({path: url.pathname, method: req.method(), body});
    if (url.pathname.endsWith('/workspace')) response = {ok: true, data: {lead, requirements, transactions: [], activities: [], followUps: []}};
    else if (url.pathname === '/api/v2/clients/L1') {lead = {...lead, ...body}; response = {ok: true, data: lead};}
    else if (url.pathname === '/api/v2/clients/L1/requirements') {
      requirements.push({...body, RequirementID: 'R1', LeadID: 'L1', TransactionID: null});
      response = {ok: true, data: requirements[0]};
    } else if (url.pathname === '/api/v2/requirements/R1' && req.method() === 'PATCH') {
      Object.assign(requirements[0], body); response = {ok: true, data: {requirement: requirements[0]}};
    } else if (url.pathname.endsWith('/subcategories')) response = {ok: true, data: ['Flat', 'Office']};
    else if (url.pathname.endsWith('/form-config')) {
      const commercial = url.searchParams.get('category') === 'Commercial';
      const fields = [
        {FieldKey: 'BudgetMax', FieldLabel: 'Budget Max', FieldType: 'Number', Active: true},
        {FieldKey: 'Location1', FieldLabel: 'Location', FieldType: 'Text', Active: true},
        {FieldKey: commercial ? 'BusinessType' : 'BHKMin', FieldLabel: commercial ? 'Business use' : 'BHK', FieldType: commercial ? 'Text' : 'Number', Active: true}
      ];
      response = {ok: true, data: {fields}};
    }
    await route.fulfill({json: response});
  });
  await page.goto('/client-workspace.html?id=L1');
  await expect(page.locator('#edit-name')).toHaveValue('Sample Client');
  await expect(page.locator('#edit-mobile')).toHaveValue('9876543210');
  await page.locator('#edit-purpose').selectOption('Rent');
  await page.locator('#edit-property-type').fill('Commercial');
  await expect(page.locator('#edit-bhk')).toBeHidden();
  await expect(page.locator('#edit-budget-max-label')).toHaveText('Monthly Rent Max (₹)');
  await page.locator('#edit-location').fill('Vesu');
  await page.getByTestId('save-client-edit').click();
  await expect(page.locator('#edit-location')).toHaveValue('Vesu');
  expect(lead.RequirementType).toBe('Rent');
  expect(lead.PropertyType).toBe('Commercial');
  expect(lead.BHK).toBeNull();
  await page.getByTestId('edit-add-requirement').click();
  await page.getByTestId('need-txn-type').selectOption('Purchase');
  await page.getByTestId('need-category').selectOption('Residential');
  await expect(page.locator('#need-fld-BHKMin')).toBeVisible();
  await page.locator('#need-fld-BHKMin').fill('2');
  await page.getByTestId('need-category').selectOption('Commercial');
  await expect(page.locator('#need-fld-BusinessType')).toBeVisible();
  await expect(page.locator('#need-fld-BHKMin')).toHaveCount(0);
  await page.locator('#need-fld-BusinessType').fill('Office');
  await page.getByTestId('save-need-btn').click();
  await expect(page.locator('#add-need-modal')).toHaveClass(/hidden/);
  await expect(page.locator('[data-edit-transaction="R1"]')).toBeVisible().catch(async error => { console.log('FORM DIAGNOSTIC', await page.locator('#workspace-error').textContent(), JSON.stringify(requirements), await page.locator('#edit-requirements-list').textContent()); throw error; });
  await page.locator('[data-edit-transaction="R1"]').click();
  await expect(page.locator('#need-fld-BusinessType')).toHaveValue('Office');
  await page.locator('#need-fld-BudgetMax').fill('9000000');
  await page.getByTestId('save-need-btn').click();
  await expect(page.locator('#add-need-modal')).toHaveClass(/hidden/);
  expect(requirements).toHaveLength(1);
  expect(requirements[0].BudgetMax).toBe(9000000);
  expect(writes.some(w => w.path.includes('/transactions'))).toBe(false);
  expect(writes.filter(w => w.path === '/api/v2/clients/L1/requirements')).toHaveLength(1);
  await expect(page.locator('#edit-name')).toHaveValue('Sample Client');
  await expect(page.locator('#edit-mobile')).toHaveValue('9876543210');
});

test('Sheet details prefill an unsaved requirement and lifecycle actions are available in the main form', async ({page}) => {
  const lead={LeadID:'SHEET',ClientName:'Sheet Test',PrimaryMobile:'9876543210',SheetBasicRequirements:[{SourceTab:'Rent',TransactionType:'Rent',Category:'Residential',BudgetMax:45000,Location1:'Vesu',BHKMin:3}]};
  const requirements=[{RequirementID:'R1',LeadID:'SHEET',TransactionType:'Rent',Category:'Residential',RequirementStatus:'Active',BHKMin:3}];
  const writes=[];
  await page.route('**/client-workspace.html?*',route=>route.fulfill({path:require('path').join(__dirname,'../client-workspace.html'),contentType:'text/html'}));
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    const body=req.postDataJSON()||{};
    let response={ok:true,data:[]};
    if(req.method()!=='GET')writes.push({path:url.pathname,body});
    if(url.pathname.endsWith('/workspace'))response={ok:true,data:{lead,requirements,transactions:[],followUps:[],activities:[],timeline:[]}};
    else if(url.pathname.endsWith('/subcategories'))response={ok:true,data:['Flat']};
    else if(url.pathname.endsWith('/form-config'))response={ok:true,data:{fields:[
      {FieldKey:'BudgetMax',FieldLabel:'Rent',FieldType:'Number',Active:true},
      {FieldKey:'Location1',FieldLabel:'Location',FieldType:'Text',Active:true},
      {FieldKey:'BHKMin',FieldLabel:'BHK',FieldType:'Number',Active:true}
    ]}};
    else if(url.pathname==='/api/v2/requirements/R1'&&req.method()==='PATCH')Object.assign(requirements[0],body);
    await route.fulfill({json:response});
  });
  await page.goto('/client-workspace.html?id=SHEET');
  await page.getByRole('button',{name:'Use Sheet Details',exact:true}).click();
  await expect(page.locator('#need-txn-type')).toHaveValue('Rent');
  await expect(page.locator('#need-fld-BudgetMax')).toHaveValue('45000');
  await expect(page.locator('#need-fld-BHKMin')).toHaveValue('3');
  expect(writes).toHaveLength(0);
  await page.getByTestId('cancel-need-btn').click();
  await expect(page.locator('#edit-requirements-list')).toContainText('BHK: 3');
  await page.locator('#edit-requirements-list').getByRole('button',{name:'Lost Requirement',exact:true}).click();
  await expect(page.locator('#mark-lost-modal')).not.toHaveClass(/hidden/);
  await page.locator('#lost-reason').selectOption({index:1});
  await page.locator('#mark-lost-modal').getByRole('button',{name:'Confirm Lost',exact:true}).click();
  await expect(page.locator('#edit-requirements-list').getByRole('button',{name:'Reopen Requirement',exact:true})).toBeVisible();
  await page.locator('#edit-requirements-list').getByRole('button',{name:'Reopen Requirement',exact:true}).click();
  await expect(page.locator('#edit-requirements-list').getByRole('button',{name:'Close Requirement',exact:true})).toBeVisible();
  expect(writes.map(w=>w.body.RequirementStatus)).toEqual(['Lost','Active']);
  expect(requirements).toHaveLength(1);
});
