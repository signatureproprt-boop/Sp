const { test, expect } = require('@playwright/test');

test('slow Close, Lost and Reopen saves cannot submit twice or change client identity', async ({ page }) => {
  const lead = { LeadID: 'L1', ClientName: 'Load Test Client', PrimaryMobile: '9876543210', ClientStatus: 'New' };
  const requirement = { RequirementID: 'R1', LeadID: 'L1', TransactionType: 'Purchase', Category: 'Residential', RequirementStatus: 'Active' };
  const writes = [];
  let release;
  await page.route('**/client-workspace.html?*', route => route.fulfill({ path: require('path').join(__dirname, '../client-workspace.html'), contentType: 'text/html' }));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let response = { ok: true, data: [] };
    if (path.endsWith('/workspace')) response = { ok: true, data: { lead, requirements: [requirement], transactions: [], followUps: [], activities: [], timeline: [] } };
    if (path === '/api/v2/requirements/R1' && request.method() === 'PATCH') {
      const body = request.postDataJSON(); writes.push(body);
      await new Promise(resolve => { release = resolve; });
      Object.assign(requirement, body); response = { ok: true, data: { requirement } };
    }
    await route.fulfill({ json: response });
  });
  await page.goto('/client-workspace.html?id=L1');
  await page.locator('#edit-requirements-list').getByRole('button', { name: 'Close Requirement', exact: true }).click();
  await page.locator('#requirement-status-reason').selectOption('Other');
  await page.locator('#requirement-status-submit').click();
  await expect(page.locator('#requirement-status-submit')).toBeDisabled();
  await expect(page.locator('#requirement-status-submit')).toHaveText('Saving…');
  await page.evaluate(() => { void saveRequirementStatus(); });
  await page.waitForTimeout(100);
  expect(writes).toHaveLength(1); release();
  await expect(page.locator('#edit-requirements-list')).toContainText('Closed');
  expect(lead.ClientStatus).toBe('New');

  requirement.RequirementStatus = 'Active'; await page.reload();
  await page.locator('#edit-requirements-list').getByRole('button', { name: 'Lost Requirement', exact: true }).click();
  await page.locator('#lost-reason').selectOption('Other');
  await page.locator('#lost-submit').click();
  await expect(page.locator('#lost-submit')).toBeDisabled();
  await page.evaluate(() => { void saveMarkLost(); });
  await page.waitForTimeout(100);
  expect(writes).toHaveLength(2); release();
  await expect(page.locator('#edit-requirements-list').getByRole('button', { name: 'Reopen Requirement', exact: true })).toBeVisible();
  await page.locator('#edit-requirements-list').getByRole('button', { name: 'Reopen Requirement', exact: true }).click();
  await expect(page.locator('#edit-requirements-list').getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await page.evaluate(() => { void reopenRequirement('R1'); });
  await page.waitForTimeout(100);
  expect(writes).toHaveLength(3); release();
  await expect(page.locator('#edit-requirements-list').getByRole('button', { name: 'Close Requirement', exact: true })).toBeVisible();
  expect(writes.map(row => row.RequirementStatus)).toEqual(['Closed', 'Lost', 'Active']);
  await expect(page.locator('#edit-name')).toHaveValue('Load Test Client');
});
