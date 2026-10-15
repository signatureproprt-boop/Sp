const {test,expect}=require('@playwright/test');
const path=require('node:path');
test('Dashboard opens due reminders, shows saved Lost status and schedules against a selected client requirement',async({page})=>{
  let booking, cancelled=false, shortlisted=false;
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  await page.route('**/dashboard-actions.js',r=>r.fulfill({path:path.join(__dirname,'../dashboard-actions.js'),contentType:'application/javascript'}));
  await page.route('**/api/**',async r=>{
    const u=new URL(r.request().url());
    let data=[];
    if(u.pathname.includes('auth')) data={userId:'U1',name:'QA',role:'Admin'};
    if(u.pathname==='/api/v2/clients') data=[{LeadID:'LOST1',ClientName:'Lost QA',ClientStatus:'Lost'}];
    if(u.pathname==='/api/v2/clients/query') data=[{LeadID:'QA1',ClientName:'Selected QA'}];
    if(u.pathname==='/api/reports/dashboard') data={executive:{totalLeads:1},pipeline:{},financial:{},inventory:{}};
    if(u.pathname==='/api/v2/followups') data=[{FollowUpID:'F1',LeadID:'QA1',Notes:'Call about brochure',DueAt:'2026-10-15T04:30:00Z',Status:'OPEN'}];
    if(u.pathname==='/api/v2/clients/QA1/workspace') data={lead:{LeadID:'QA1'},requirements:[{RequirementID:'R1',Status:'Active',Category:'Residential'},{RequirementID:'R2',Status:'Active',RequirementStatus:'Closed'},{RequirementID:'R3',Status:'Archived'}]};
    if(u.pathname==='/api/v2/inventory') data=[{PropertyID:'P1',Title:'QA property'}];
    if(u.pathname==='/api/v2/shortlist/R1/add'){expect(r.request().postDataJSON()).toEqual({propertyId:'P1'});shortlisted=true;data={ShortlistID:'S1'};}
    if(u.pathname==='/api/v2/site-visit-bookings'&&r.request().method()==='POST'){expect(shortlisted).toBe(true);booking=r.request().postDataJSON();data={VisitBookingID:'B1'};}
    if(u.pathname==='/api/v2/site-visit-bookings/B1/cancel'){cancelled=true;data={VisitBookingID:'B1',Status:'Cancelled'};}
    if(u.pathname==='/api/v2/site-visit-bookings'&&r.request().method()==='GET'&&booking)data=[{VisitBookingID:'B1',LeadID:'QA1',RequirementID:'R1',VisitDate:today,VisitTime:'11:30',Status:cancelled?'Cancelled':'Scheduled',Properties:[{PropertyID:'P1',Title:'QA property'}]}];
    await r.fulfill({json:{ok:true,authenticated:true,user:{UserID:'U1',FullName:'QA',Role:'Admin'},data}});
  });
  await page.route('**/dashboard-test',r=>r.fulfill({path:path.join(__dirname,'../index.html'),contentType:'text/html'}));
  await page.goto('/dashboard-test');
  await expect(page.locator('#clients')).toContainText('Lost QA');
  await expect(page.locator('#clients .status')).toHaveText('Lost');
  await page.getByRole('link',{name:'Overdue / due follow-ups 1',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Dashboard work'});
  await expect(dialog).toContainText('Call about brochure');
  await expect(dialog.getByRole('link',{name:'QA1',exact:true})).toHaveAttribute('href','/client-workspace?id=QA1');
  await expect(dialog.locator('article')).toHaveCount(1);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('link',{name:'📅 Site Visit',exact:true}).click();
  await expect(dialog).toContainText('Schedule a site visit');
  await expect(dialog.locator('#visit-requirement')).toBeDisabled();
  await dialog.locator('#visit-client').selectOption('QA1');
  await expect(dialog.locator('#visit-requirement option')).toHaveCount(2);
  await dialog.locator('#visit-requirement').selectOption('R1');
  await dialog.locator('#visit-property').selectOption('P1');
  await dialog.locator('#visit-date').fill(today);
  await dialog.locator('#visit-time').fill('11:30');
  await dialog.getByRole('button',{name:'Shortlist & schedule visit',exact:true}).click();
  await expect(dialog.getByRole('status')).toContainText('Site visit saved');
  expect(booking).toMatchObject({requirementId:'R1',propertyIds:['P1'],visitDate:today,visitTime:'11:30'});
  await expect(dialog.locator('#visit-list')).toContainText('QA property');
  page.once('dialog',d=>d.accept());
  await dialog.getByRole('button',{name:'Cancel visit',exact:true}).click();
  await expect(dialog.getByRole('status')).toHaveText('Site visit cancelled.');
  await expect(dialog.locator('#visit-list')).toHaveText('No site visits scheduled for today.');
  expect(cancelled).toBe(true);
});
