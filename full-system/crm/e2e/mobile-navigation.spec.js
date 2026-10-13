const { test, expect } = require('@playwright/test');
test.use({ hasTouch:true, isMobile:true });

test('tablet dashboard keeps navigation reachable', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1000 });
  await page.goto('/index.html');
  const toggle = page.locator('#nav-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator('#mobile-menu')).toBeVisible();
  await expect(page.locator('#mobile-menu a[href="/builder-projects"]')).toBeVisible();
});

test('narrow mobile sign-in fits PIN boxes without opening keyboard on load', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/login.html');
  const inputs = page.locator('.pins input');
  await expect(inputs).toHaveCount(4);
  const geometry = await inputs.evaluateAll((boxes) => boxes.map((box) => {
    const rect = box.getBoundingClientRect();
    return { left:rect.left,right:rect.right,width:rect.width };
  }));
  expect(geometry.every((box) => box.left >= 0 && box.right <= 320 && box.width >= 40)).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.matches('.pins input'))).toBe(false);
});
