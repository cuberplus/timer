import { test, expect } from '@playwright/test';

test('MAC address help opens separately, remains local, and links back to Timer', async ({ page }) => {
  const external: string[] = [];
  page.context().on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url());
  });
  await page.goto('');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  const input = page.getByPlaceholder('AA:BB:CC:DD:EE:FF');
  await input.fill('AA:BB:CC:DD:EE:FF');
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: "Find my cube's MAC address" }).click();
  const help = await popupPromise;
  await expect(help).toHaveURL(/\/timer\/help\/mac-address\.html$/);
  await expect(help.getByRole('heading', { level: 1 })).toHaveText("Find your cube's Bluetooth MAC address");
  await expect(help.locator('body')).toContainText('edge://bluetooth-internals/#devices');
  await expect(help.locator('body')).toContainText('chrome://bluetooth-internals/#devices');
  await expect(help.getByRole('heading', { name: 'Android: nRF Connect for Mobile' })).toBeVisible();
  await expect(input).toHaveValue('AA:BB:CC:DD:EE:FF');
  await help.getByRole('link', { name: 'Back to Timer' }).click();
  await expect(help).toHaveURL('http://127.0.0.1:4173/timer/');
  expect(external).toEqual([]);
});
