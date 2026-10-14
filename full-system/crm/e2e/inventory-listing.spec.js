const {test,expect}=require('@playwright/test');const path=require('node:path');
test('inventory listing price, BHK and area persist through edit and a new form resets them',async({page})=>{
  const property={PropertyID:'P1',Title:'QA listing',Category:'Residential',SubCategory:'Flat',ListingFor:'Sale',ListingStatus:'Off-market',InventorySource:'Own',Fields:{BHK:'3BHK',CarpetArea:900,AskingPrice:2600}},writes=[];
  await page.route('**/inventory',r=>r.fulfill({path:path.join(__dirname,'../inventory.html'),contentType:'text/html'}));
  await page.route('**/api/**',async r=>{
    const req=r.request(),url=new URL(req.url());let payload={ok:true,data:[]};
    if(url.pathname==='/api/v2/form-config') payload={ok:true,data:{fields:[]}};
    else if(url.pathname==='/api/v2/inventory/P1') {
      if(req.method()==='PATCH') {const body=req.postDataJSON();writes.push(body);Object.assign(property,{BHK:body.BHK,CarpetArea:body.CarpetArea});Object.assign(property.Fields,{BHK:body.BHK,CarpetArea:body.CarpetArea,AskingPrice:body.AskingPrice});}
      payload={ok:true,data:property};
    } else if(url.pathname==='/api/v2/inventory') payload={ok:true,data:[property],total:1,page:1,totalPages:1};
    await r.fulfill({json:payload});
  });
  await page.goto('/inventory');await page.getByTestId('prop-card-P1').click();
  await expect(page.getByLabel('Asking price / monthly rent (₹)')).toHaveValue('2600');
  await page.getByLabel('Listing BHK',{exact:true}).selectOption('4BHK');await page.getByLabel('Listing carpet area (sq.ft)').fill('1200');
  await page.getByRole('button',{name:'Save Property',exact:true}).click();
  await expect(page.getByTestId('prop-card-P1')).toContainText('4BHK');await expect(page.getByTestId('prop-card-P1')).toContainText('1200 sqft');
  expect(writes[0]).toMatchObject({BHK:'4BHK',CarpetArea:1200,AskingPrice:2600,ListingStatus:'Off-market'});
  await page.getByTestId('prop-card-P1').click();await expect(page.getByLabel('Listing BHK',{exact:true})).toHaveValue('4BHK');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'＋ Add Property',exact:true}).click();
  await expect(page.getByLabel('Asking price / monthly rent (₹)')).toHaveValue('');await expect(page.getByLabel('Listing BHK',{exact:true})).toHaveValue('');
});
