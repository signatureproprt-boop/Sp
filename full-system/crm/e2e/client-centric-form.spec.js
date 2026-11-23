const { test, expect } = require('@playwright/test');

test('client form keeps identity separate from dynamic requirements', async ({page}) => {
  let lead = {LeadID: 'L1', ClientName: 'Sample Client', PrimaryMobile: '9876543210', ClientStatus: 'New', ClientLifecycle: 'Prospect', Source: 'Manual', RequirementType: 'Rent', PropertyType: 'Commercial', BudgetMax: 7000000};
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
      response = {ok: true, data: {category: url.searchParams.get('category'), fields}};
    }
    await route.fulfill({json: response});
  });
  await page.goto('/client-workspace.html?id=L1');
  await expect(page.locator('#edit-name')).toHaveValue('Sample Client');
  await expect(page.locator('#edit-mobile')).toHaveValue('9876543210');
  await expect(page.locator('#edit-purpose')).toHaveCount(0);
  await expect(page.locator('#edit-property-type')).toHaveCount(0);
  await page.getByTestId('save-client-edit').click();
  expect(lead.RequirementType).toBe('Rent');
  expect(lead.PropertyType).toBe('Commercial');
  expect(lead.BudgetMax).toBe(7000000);
  const clientPatch = writes.find(w => w.path === '/api/v2/clients/L1');
  expect(clientPatch.body).not.toHaveProperty('RequirementType');
  expect(clientPatch.body).not.toHaveProperty('PropertyType');
  expect(clientPatch.body).not.toHaveProperty('BudgetMax');
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

test('Legacy Sheet details are hidden when a confirmed requirement already exists', async ({page}) => {
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
  await expect(page.locator('#sheet-basic-panel')).toBeHidden();
  await expect(page.getByRole('button',{name:'Edit Sheet Requirement',exact:true})).toHaveCount(0);
  expect(writes).toHaveLength(0);
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

test('a requirement confirmed from a Sheet row replaces the old Sheet prompt', async ({page}) => {
  const lead={LeadID:'LINKED',ClientName:'Linked Sheet',SheetBasicRequirements:[{SourceTab:'Rent',SourceRow:5,TransactionType:'Rent',Category:'Commercial',BudgetMax:15000000,Location1:'Vesu'}]};
  const requirements=[{RequirementID:'R2',LeadID:'LINKED',ClientRequestID:'sheet-requirement:Rent:row:5',_source:'googlesheet:Rent',CreatedBy:'GoogleSheetsSync',TransactionType:'Purchase',Category:'Residential',SubCategory:'Flat',RequirementStatus:'Active',BudgetMin:20000000,BudgetMax:25000000,Location1:'Vesu',BHKMin:4}];
  await page.route('**/client-workspace.html?*',route=>route.fulfill({path:require('path').join(__dirname,'../client-workspace.html'),contentType:'text/html'}));
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    let response={ok:true,data:[]};
    if(url.pathname.endsWith('/workspace'))response={ok:true,data:{lead,requirements,transactions:[],followUps:[],activities:[],timeline:[]}};
    else if(url.pathname.endsWith('/subcategories'))response={ok:true,data:['Flat']};
    else if(url.pathname.endsWith('/form-config'))response={ok:true,data:{fields:[]}};
    await route.fulfill({json:response});
  });
  await page.goto('/client-workspace.html?id=LINKED');
  await expect(page.locator('#sheet-basic-panel')).toBeHidden();
  await expect(page.locator('#edit-requirements-list')).toContainText('Purchase · Residential');
  await expect(page.locator('#edit-requirements-list')).toContainText('₹2,00,00,000 – ₹2,50,00,000');
  await expect(page.locator('#edit-requirements-list')).toContainText('BHK: 4');
  await expect(page.getByRole('button',{name:'Edit Sheet Requirement',exact:true})).toHaveCount(0);
});
