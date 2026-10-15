const {test,expect}=require('@playwright/test');
const path=require('node:path');
test('builder, residential, BHK and carpet bounds filter together and support builder-category groups',async({page})=>{
 const match={ProjectID:'MATCH',ProjectName:'Matching 3 BHK',BuilderName:'Avadh',Category:'Residential',Location1:'Vesu',ConfigDetails:[{Type:'3 BHK',CarpetAreaSqft:1200}]};
 const other={...match,ProjectID:'OTHER',ProjectName:'Nonmatching project'};
 let finalQuery;
 await page.route('**/builder-projects',r=>r.fulfill({path:path.join(__dirname,'../builder-projects.html'),contentType:'text/html'}));
 await page.route('**/api/**',async r=>{
  const u=new URL(r.request().url()),q=u.searchParams;let json={ok:true,data:[]};
  if(u.pathname==='/api/v2/builder-projects/builders') json={ok:true,data:[{name:'Avadh',count:2}]};
  if(u.pathname==='/api/v2/builder-projects'){
   const combined=q.get('builder')==='Avadh'&&q.get('category')==='Residential'&&q.get('bhk')==='3 BHK'&&q.get('carpetMin')==='1000'&&q.get('carpetMax')==='1500';
   const rows=combined?[match]:[match,other];if(combined) finalQuery=q;
   json={ok:true,data:rows,pagination:{total:rows.length,totalPages:1}};
  }
  await r.fulfill({json});
 });
 await page.goto('/builder-projects');
 await page.getByLabel('Choose builder',{exact:true}).selectOption('Avadh');
 await page.getByTestId('filter-cat-residential').click();
 await expect(page.getByLabel('BHK',{exact:true})).toBeVisible();
 await page.getByLabel('BHK',{exact:true}).selectOption('3 BHK');
 await page.getByLabel('Carpet minimum sqft',{exact:true}).fill('1000');
 await page.getByLabel('Carpet maximum sqft',{exact:true}).fill('1500');
 await page.getByLabel('Carpet maximum sqft',{exact:true}).press('Tab');
 await expect(page.getByTestId('project-card-OTHER')).toHaveCount(0);
 await expect(page.getByTestId('project-card-MATCH')).toBeVisible();
 expect(finalQuery.get('builtUpMin')).toBeNull();
 await expect(page.locator('#active-project-filters')).toContainText('Avadh · Residential');
 await expect(page.locator('#active-project-filters')).toContainText('3 BHK · Carpet 1000–1500 sqft');
 await page.getByLabel('Group projects',{exact:true}).selectOption('builder-category');
 await expect(page.locator('#grid > details > summary')).toContainText('Avadh');
 await page.locator('#grid > details > summary').click();
 await expect(page.locator('#grid > details > details > summary')).toContainText('Residential');
 await page.getByRole('button',{name:'Reset filters',exact:true}).click();
 await expect(page.getByLabel('Carpet minimum sqft',{exact:true})).toHaveValue('');
 await expect(page.getByLabel('BHK',{exact:true})).toHaveValue('');
});
