const {test,expect}=require('@playwright/test');

test('edited lower-case budget fields beat profile prefills and explicit clears persist',async({page})=>{
 const lead={LeadID:'L1',ClientName:'QA Client',PrimaryMobile:'9876543210',ClientStatus:'New',BudgetMax:7500000,Location1:'Vesu'};
 const requirements=[],writes=[];
 await page.route('**/client-workspace.html?*',r=>r.fulfill({path:require('node:path').join(__dirname,'../client-workspace.html'),contentType:'text/html'}));
 await page.route('**/api/**',async r=>{
  const req=r.request(),p=new URL(req.url()).pathname;let response={ok:true,data:[]};
  if(p.endsWith('/workspace'))response={ok:true,data:{lead,requirements,transactions:[],followUps:[],activities:[],timeline:[]}};
  else if(p.endsWith('/form-config'))response={ok:true,data:{fields:[{FieldKey:'budgetMin',FieldLabel:'Budget Min',FieldType:'Number',Active:true},{FieldKey:'budgetMax',FieldLabel:'Budget Max',FieldType:'Number',Active:true}]}};
  else if(p==='/api/v2/clients/L1/requirements'&&req.method()==='POST'){
   const body=req.postDataJSON();writes.push(body);requirements.push({...body,RequirementID:'R1',LeadID:'L1',TransactionID:null});response={ok:true,data:requirements[0]};
  }else if(p==='/api/v2/requirements/R1'&&req.method()==='PATCH'){
   const body=req.postDataJSON();writes.push(body);Object.assign(requirements[0],body);response={ok:true,data:{requirement:requirements[0]}};
  }
  await r.fulfill({json:response});
 });
 await page.goto('/client-workspace.html?id=L1');
 await page.getByTestId('edit-add-requirement').click();await page.getByTestId('need-txn-type').selectOption('Purchase');await page.getByTestId('need-category').selectOption('Residential');
 await expect(page.locator('#need-fld-budgetMax')).toHaveValue('7500000');
 await page.locator('#need-fld-budgetMin').fill('1000');await page.locator('#need-fld-budgetMax').fill('2000');await page.getByRole('button',{name:'Add Requirement',exact:true}).click();
 await expect.poll(()=>writes.length).toBe(1);
 expect(writes[0]).toMatchObject({BudgetMin:1000,BudgetMax:2000,budgetMin:1000,budgetMax:2000});
 await expect(page.locator('#edit-requirements-list')).toContainText('₹1,000 – ₹2,000');
 await page.reload();await expect(page.locator('#edit-requirements-list')).toContainText('₹1,000 – ₹2,000');
 await page.getByRole('button',{name:'✏️ Edit Property Details',exact:true}).click();await expect(page.locator('#need-fld-budgetMax')).toHaveValue('2000');
 await page.locator('#need-fld-budgetMax').fill('');await page.getByRole('button',{name:'Save Requirement',exact:true}).click();
 await expect(page.locator('#add-need-modal')).toBeHidden();expect(writes[1].BudgetMax).toBeNull();expect(writes[1].budgetMax).toBeNull();expect(lead.BudgetMax).toBe(7500000);
});
