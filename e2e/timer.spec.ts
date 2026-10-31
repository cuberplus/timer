import { test, expect } from '@playwright/test';

for (const stalled of ['connect', 'discover']) test(`Bluetooth ${stalled} stall reports a bounded GATT error and allows retry`, async ({ page }) => {
  await page.addInitScript(operation => {
    const device = Object.assign(new EventTarget(), { name: 'WCU_MY33_1234', id: 'test-cube' });
    const gatt = {
      connect: async (): Promise<object> => {
        if (operation === 'connect') return new Promise(() => {});
        return gatt;
      },
      getPrimaryServices: async () => new Promise(() => {}),
      disconnect: () => { document.documentElement.dataset.gattDisconnected = 'true'; },
    };
    Object.assign(device, { gatt });
    Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: async () => device } });
  }, stalled);
  await page.goto('');
  await page.getByRole('button', { name: 'Connect cube', exact: true }).click();
  const stage = stalled === 'connect' ? 'Opening Bluetooth GATT connection' : 'Discovering Bluetooth services';
  await expect(page.getByRole('status')).toHaveText(stage);
  await expect(page.getByRole('alert')).toContainText(`${stage} timed out after 15 seconds`, { timeout: 20000 });
  await expect(page.getByRole('button', { name: 'Connect cube', exact: true })).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-gatt-disconnected', 'true');
});

for (const action of ['Enter', 'click']) test(`Bluetooth ${action} opens the picker, shows progress, and permits retry after cancellation`, async ({ page }) => {
  const logs: string[] = [];
  page.on('console', message => { if (message.text().includes('[Timer Bluetooth')) logs.push(message.text()); });
  await page.addInitScript(() => {
    if (!localStorage.getItem('timer-last-cube-mac')) localStorage.setItem('timer-last-cube-mac', '11:22:33:44:55:66');
    Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: {
      requestDevice: async () => {
        const root = document.documentElement;
        root.dataset.pickerRequests = String(Number(root.dataset.pickerRequests ?? 0) + 1);
        await new Promise<void>(resolve => document.addEventListener('cancel-test-picker', () => resolve(), { once: true }));
        throw new DOMException('Test chooser canceled.', 'NotFoundError');
      },
    } });
  });
  await page.goto('');
  const connect = page.getByRole('button', { name: 'Connect cube', exact: true });
  const mac = page.getByPlaceholder('AA:BB:CC:DD:EE:FF');
  await expect(connect).toBeEnabled();
  await expect(mac).toHaveValue('11:22:33:44:55:66');
  await mac.fill('AA:BB:CC:DD:EE:FF');
  if (action === 'Enter') await mac.press('Enter');
  else await connect.click();
  await expect(page.locator('html')).toHaveAttribute('data-picker-requests', '1');
  await expect(page.getByRole('button', { name: 'Connecting...', exact: true })).toBeDisabled();
  await expect(mac).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('Select your cube…');
  await page.locator('form').dispatchEvent('submit');
  await expect(page.locator('html')).toHaveAttribute('data-picker-requests', '1');
  await page.evaluate(() => document.dispatchEvent(new Event('cancel-test-picker')));
  await expect(page.getByRole('alert')).toContainText('Test chooser canceled.');
  await expect(connect).toBeEnabled();
  await expect(mac).toBeEnabled();
  await expect(page.getByRole('status')).not.toHaveText('Select your cube…');
  expect(logs.some(message => message.includes('Connect requested'))).toBe(true);
  expect(logs.some(message => message.includes('Connection stage') && message.includes('Select your cube'))).toBe(true);
  expect(logs.some(message => message.includes('Library connection failed') && message.includes('Test chooser canceled.'))).toBe(true);
  await mac.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-picker-requests', '2');
  await page.evaluate(() => document.dispatchEvent(new Event('cancel-test-picker')));
  await expect(connect).toBeEnabled();
  await page.reload();
  await expect(mac).toHaveValue('11:22:33:44:55:66');
});

test('browser-only scramble, solve, persistence, replay and backup', async ({ page }) => {
  const external: string[] = [];
  const failures: string[] = [];
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url());
  });
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('');
  await expect(page.getByRole('button', { name: 'Try simulated cube' })).toBeEnabled();
  await page.getByRole('button', { name: 'Try simulated cube' }).click();
  const guided = page.getByRole('button', { name: 'Perform guided move' });
  await expect(guided).toBeEnabled({ timeout: 45000 });
  const first = (await page.locator('.scramble .current').innerText())[0];
  await page.getByRole('button', { name: first === 'L' ? 'F' : 'L', exact: true }).click();
  await expect(page.getByText('Wrong turn.', { exact: false })).toBeVisible();
  for (let i = 0; i < 60; i++) {
    if (await page.getByText('Scramble complete. Your next face turn starts the timer.', { exact: true }).isVisible()) break;
    await guided.click();
  }
  await expect(page.getByText('Scramble complete. Your next face turn starts the timer.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Solve time')).toHaveText('0.00');
  await page.getByRole('button', { name: 'Simulate solve' }).click();
  await expect(page.getByText('Solved! Your full move timeline is recorded.', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Solve replay' })).toBeVisible();
  await page.getByRole('button', { name: 'Next move', exact: true }).click();
  await expect(page.getByLabel('Replay move')).toHaveValue('1');
  await page.getByRole('button', { name: 'Close replay' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^timer-.*\.json$/);
  await page.reload();
  await expect(page.getByRole('row')).toHaveCount(2);
  expect(external).toEqual([]);
  expect(failures).toEqual([]);
});

test('rejects invalid backups without changing history', async ({ page }) => {
  await page.goto('');
  await expect(page.getByRole('button', { name: 'Try simulated cube' })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({
    name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"timer-v1","solves":[null]}'),
  });
  await expect(page.getByRole('alert')).toContainText('Invalid solve');
  await expect(page.getByRole('row')).toHaveCount(1);
});

test('reload preserves an interrupted solve as incomplete', async ({ page }) => {
  await page.goto('');
  await page.getByRole('button', { name: 'Try simulated cube' }).click();
  const guided = page.getByRole('button', { name: 'Perform guided move' });
  await expect(guided).toBeEnabled({ timeout: 45000 });
  for (let i = 0; i < 60; i++) {
    if (await page.getByText('Scramble complete. Your next face turn starts the timer.', { exact: true }).isVisible()) break;
    await guided.click();
  }
  await page.getByRole('button', { name: 'U', exact: true }).click();
  await expect(page.getByText('1 reported moves recorded')).toBeVisible();
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('cell', { name: 'incomplete (simulated)' })).toBeVisible();
});

test('storage failure is visible and never reports a successful save', async ({ page }) => {
  await page.addInitScript(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      if (args[1] === 'readwrite') throw new DOMException('Storage quota exceeded.', 'QuotaExceededError');
      return transaction.apply(this, args);
    };
  });
  await page.goto('');
  await page.getByRole('button', { name: 'Try simulated cube' }).click();
  const guided = page.getByRole('button', { name: 'Perform guided move' });
  await expect(guided).toBeEnabled({ timeout: 45000 });
  for (let i = 0; i < 60; i++) {
    if (await page.getByText('Scramble complete. Your next face turn starts the timer.', { exact: true }).isVisible()) break;
    await guided.click();
  }
  await page.getByRole('button', { name: 'U', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Storage quota exceeded');
  await expect(page.getByText('Not saved - export a backup now', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved locally', { exact: true })).toHaveCount(0);
});
