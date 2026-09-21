const { test, expect } = require('@playwright/test');

test('CRM login page loads', async ({ page }) => {
  const response = await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expect(page).toHaveTitle(/Signature Realty/i);
  await expect(page.locator('body')).toContainText(/Google|PIN|Login/i);
});
