const {test,expect}=require('@playwright/test');
const path=require('node:path');

test('groups projects across pages by category, location and builder; filters survive view changes',async({page})=>{
  const rows=[
    {ProjectID:'G1',ProjectName:'First Vesu',Category:'Residential',Location1:'Vesu',BuilderName:'Avadh'},
    {ProjectID:'G2',ProjectName:'Second Vesu',Category:'Residential',Location1:' vesu ',BuilderName:'Avadh'},
    {ProjectID:'G3',ProjectName:'Pal office',Category:'Commercial',Location1:'Pal',BuilderName:'Sangini'},
    {ProjectID:'G4',ProjectName:'Unassigned',Category:'Land'}
  ];
  const requests=[];
  await page.route('**/builder-projects',r=>r.fulfill({path:path.join(__dirname,'../builder-projects.html'),contentType:'text/html'}));
  await page.route('**/api/**',async r=>{
    const u=new URL(r.request().url());let json={ok:true,data:[]};
    if(u.pathname==='/api/v2/builder-projects'){
      requests.push(u.searchParams.toString());
      let filtered=rows.filter(p=>!u.searchParams.get('category')||p.Category===u.searchParams.get('category'));
      const index=Number(u.searchParams.get('page')||1);
      json={ok:true,data:filtered.slice((index-1)*2,index*2),pagination:{total:filtered.length,totalPages:Math.ceil(filtered.length/2)}};
    }
    await r.fulfill({json});
  });
  await page.goto('/builder-projects');
  await expect(page.getByLabel('Group projects',{exact:true})).toHaveValue('none');
  await expect(page.getByTestId('project-card-G1')).toBeVisible();
  expect((await page.getByTestId('project-card-G1').boundingBox()).y).toBeLessThan(600);
  await expect(page.getByLabel('Carpet minimum sqft',{exact:true})).not.toBeVisible();
  await page.getByLabel('Group projects',{exact:true}).selectOption('category-location-builder');
  await expect(page.getByTestId('project-card-G4')).toBeAttached();
  // Whitespace and casing variants share one location group across API pages.
  await expect(page.locator('[data-group-dimension="location"]').filter({hasText:'First Vesu'})).toContainText(/Vesu\s*2 projects/);
  await expect(page.locator('#grid > details')).toHaveCount(3);
  await expect(page.getByTestId('project-card-G1')).not.toBeVisible();
  for (const summary of await page.locator('#grid details > summary').all()) await summary.click();
  await expect(page.getByTestId('project-card-G1')).toBeVisible();
  await expect(page.locator('#overview-projects')).toHaveText('4');
  await expect(page.getByRole('button',{name:'🔄 Scrape Karma Group',exact:true})).not.toBeVisible();
  await page.locator('#project-tools > summary').click();
  await expect(page.getByRole('button',{name:'🔄 Scrape Karma Group',exact:true})).toBeVisible();
  await page.locator('#project-tools > summary').click();
  await page.getByLabel('Group projects',{exact:true}).selectOption('location-category-builder');
  await expect(page.locator('#grid > details > summary').filter({hasText:/Vesu\s*2 projects/})).toBeVisible();
  await page.getByTestId('filter-cat-residential').click();
  await expect(page.getByTestId('project-card-G3')).toHaveCount(0);
  await expect(page.getByTestId('project-card-G2')).toBeAttached();
  await page.getByLabel('Group projects',{exact:true}).selectOption('builder-category-location');
  await expect(page.locator('#grid > details > summary')).toContainText(/Avadh\s*2 projects/);
  await page.getByLabel('Group projects',{exact:true}).selectOption('none');
  await expect(page.locator('#grid > details')).toHaveCount(0);
  await expect(page.getByTestId('project-card-G1')).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(requests.at(-1)).toContain('category=Residential');
  expect(requests.some(q=>q.includes('page=2'))).toBeTruthy();
});
