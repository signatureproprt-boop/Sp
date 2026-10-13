const {test, expect} = require('@playwright/test');
const path = require('node:path');

test('capture accepts identity alone and ignores stale residential BHK for commercial', async ({page}) => {
  const writes = [];
  await page.route('**/client-workspace-hub.html', route => route.fulfill({path: path.join(__dirname, '../client-workspace-hub.html'), contentType: 'text/html'}));
  await page.route('**/api/**', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      writes.push(request.postDataJSON());
      await route.fulfill({json: {ok: false, error: 'Capture checked'}});
    } else await route.fulfill({json: {ok: true, data: [], totalCount: 0}});
  });
  await page.goto('/client-workspace-hub.html');
  await page.evaluate(() => openNewClient());
  await page.locator('#nc-name').fill('New Client');
  await page.locator('#nc-mobile').fill('9876543210');
  await expect(page.locator('#nc-bhk')).toBeHidden();
  await page.getByRole('button', {name: 'Create Lead & Open Workspace'}).click();
  await expect(page.locator('#nc-error')).toHaveText('Capture checked');
  expect(writes).toHaveLength(1);
  expect(writes[0].client.name).toBe('New Client');
  await page.locator('#nc-cat').selectOption('Residential');
  await expect(page.locator('#nc-bhk')).toBeVisible();
  await page.locator('#nc-bhk').fill('3');
  await page.locator('#nc-cat').selectOption('Commercial');
  await page.locator('#nc-txn').selectOption('Rent');
  await expect(page.locator('#nc-bhk')).toBeHidden();
  await expect(page.locator('#nc-budget-label')).toHaveText('Monthly Rent (₹)');
  await page.getByRole('button', {name: 'Create Lead & Open Workspace'}).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].requirement.BHK).toBeUndefined();
});
