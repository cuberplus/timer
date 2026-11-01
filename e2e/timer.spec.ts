import { test, expect, type Page } from '@playwright/test';
import type { Solve } from '../src/engine';

function storedSolves(page: Page): Promise<Solve[]> {
  return page.evaluate(() => new Promise<Solve[]>((resolve, reject) => {
    const opening = indexedDB.open('smart-cube-timer');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const request = db.transaction('solves').objectStore('solves').getAll();
      request.onsuccess = () => { db.close(); resolve(request.result as Solve[]); };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }));
}

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
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(mac).toHaveValue('11:22:33:44:55:66');
  await mac.fill('AA:BB:CC:DD:EE:FF');
  if (action === 'Enter') await mac.press('Enter');
  else {
    await page.getByRole('dialog', { name: 'Options', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
    await connect.click();
  }
  await expect(page.locator('html')).toHaveAttribute('data-picker-requests', '1');
  await expect(page.getByRole('button', { name: 'Connecting...', exact: true })).toBeDisabled();
  await expect(mac).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('Select your cube…');
  await page.locator('form').filter({ has: mac }).dispatchEvent('submit');
  await expect(page.locator('html')).toHaveAttribute('data-picker-requests', '1');
  await page.evaluate(() => document.dispatchEvent(new Event('cancel-test-picker')));
  await expect(page.getByRole('alert')).toContainText('Test chooser canceled.');
  await expect(connect).toBeEnabled();
  await expect(mac).toBeEnabled();
  await expect(page.getByRole('status')).not.toHaveText('Select your cube…');
  expect(logs.some(message => message.includes('Connect requested'))).toBe(true);
  expect(logs.some(message => message.includes('Connection stage') && message.includes('Select your cube'))).toBe(true);
  expect(logs.some(message => message.includes('Library connection failed') && message.includes('Test chooser canceled.'))).toBe(true);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await mac.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-picker-requests', '2');
  await page.evaluate(() => document.dispatchEvent(new Event('cancel-test-picker')));
  await expect(connect).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(mac).toHaveValue('11:22:33:44:55:66');
});

test('browser-only scramble, solve, persistence, replay and backup', async ({ page }) => {
  const history = page.getByRole('table', { name: 'Solve history' });
  const statistics = page.getByRole('table', { name: 'Session statistics' });
  const external: string[] = [];
  const failures: string[] = [];
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url());
  });
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('');
  await expect(page).toHaveTitle('CuberPlus - Timer');
  await expect(page.getByRole('heading', { name: 'CuberPlus - Timer', exact: true })).toBeVisible();
  await expect(page.getByText('Smart cube timing.', { exact: false })).toHaveCount(0);
  const simulator = page.getByText('Try simulated cube', { exact: true });
  await expect(simulator).toBeEnabled();
  await expect(simulator).toBeHidden();
  await simulator.evaluate(button => (button as HTMLButtonElement).click());
  await expect(page.getByRole('heading', { name: 'Live cube', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Scramble', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next scramble', exact: true })).toHaveCount(0);
  await expect(page.locator('.timer-panel').getByLabel('Solve time', { exact: true })).toBeVisible();
  await expect(page.locator('main > section').first()).toHaveClass(/timer-panel/);
  await expect(page.locator('.timer-panel > .scramble')).toBeVisible();
  await expect(page.locator('.timer-panel').getByRole('img', { name: 'Live 3x3 cube state' })).toBeVisible();
  const guided = page.getByRole('button', { name: 'Perform guided move' });
  await expect(guided).toBeEnabled({ timeout: 45000 });
  await expect(page.locator('.timer-panel .badge')).toHaveCount(0);
  await expect(page.locator('.timer-panel')).not.toContainText(/Follow the highlighted|Next:|Last solve|Use the cube's calibrated face/);
  const hasDoubleTurn = (await page.locator('.scramble .move').allTextContents()).some(move => move.endsWith('2'));
  const first = (await page.locator('.scramble .current').innerText())[0];
  await page.getByRole('button', { name: first === 'L' ? 'F' : 'L', exact: true }).click();
  await expect(page.getByText('Wrong turn.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Correction moves', exact: true })).toBeVisible();
  await expect(page.locator('.scramble .move:not(.done):not(.correction)')).toHaveCount(0);
  await expect(page.locator('.scramble .current.correction')).toHaveCSS('background-color', 'rgb(220, 53, 69)');
  let checkedPartial = false;
  for (let i = 0; i < 60; i++) {
    if (await page.getByRole('button', { name: 'Simulate solve', exact: true }).isEnabled()) break;
    const current = page.locator('.scramble .current:not(.correction)');
    if (!checkedPartial && await current.count() && (await current.innerText()).endsWith('2')) {
      await page.getByRole('button', { name: (await current.innerText())[0], exact: true }).click();
      await expect(current).toHaveClass(/partial/);
      await expect(current).toHaveCSS('background-color', 'rgb(245, 185, 66)');
      checkedPartial = true;
    }
    await guided.click();
  }
  expect(checkedPartial).toBe(hasDoubleTurn);
  await expect(page.getByRole('button', { name: 'Simulate solve', exact: true })).toBeEnabled();
  await expect(page.locator('.timer-panel')).not.toContainText(/Turn .+ once more|Scramble complete\./);
  await expect(page.getByLabel('Solve time', { exact: true })).toHaveText('0.00');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Time precision', { exact: true }).selectOption('3');
  await page.getByRole('dialog', { name: 'Options', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByLabel('Solve time', { exact: true })).toHaveText('0.000');
  const scramble = await page.getByLabel('Scramble', { exact: true }).innerText();
  await page.getByRole('button', { name: 'Simulate solve' }).click();
  await expect(page.getByRole('group', { name: 'Solve timeline', exact: true })).toBeVisible();
  await expect.poll(async () => parseFloat(await page.locator('.trail-tip').evaluate(element => (element as HTMLElement).style.left))).toBeGreaterThan(0);
  await expect(page.getByRole('group', { name: 'CFOP steps' })).toBeVisible();
  await expect(page.locator('.trail-duration[data-status="pending"]')).toHaveCount(1);
  await expect(history.getByRole('row')).toHaveCount(2);
  await expect(history.getByRole('columnheader')).toHaveText(['Time', 'Turns', 'TPS', 'View']);
  for (const [i, name] of ['Cross', 'F2L Pair 1', 'F2L Pair 2', 'F2L Pair 3', 'F2L Pair 4', 'OLL', 'PLL'].entries()) {
    const label = page.locator(`.trail-duration[data-step="${i}"]`);
    await expect(label).toBeVisible();
    await expect(label).toHaveAttribute('data-status', 'done');
    await expect(label).toHaveText(/^\d+\.\d{3}s$/);
    await expect(label).toHaveAttribute('aria-label', new RegExp(`^${name}: `));
  }
  const plot = page.getByRole('group', { name: 'Solve timeline', exact: true });
  await expect(plot).not.toContainText(/Base cross|Darker:|lighter:|first turn/);
  await expect(plot.locator('.badge')).toHaveCount(0);
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 375, height: 900 });
  await expect.poll(async () => page.locator('.trail-duration').evaluateAll(elements => {
    const bounds = document.querySelector('.solve-trail')!.getBoundingClientRect();
    const boxes = elements.map(element => element.getBoundingClientRect());
    return boxes.every(box => box.left >= bounds.left - 1 && box.right <= bounds.right + 1) &&
      boxes.every((box, i) => boxes.slice(i + 1).every(other => box.bottom <= other.top || other.bottom <= box.top || box.right <= other.left || other.right <= box.left));
  })).toBe(true);
  const plotBounds = (await plot.boundingBox())!;
  for (const name of ['Read cube state', 'Cube is physically solved - calibrate']) {
    const buttonBounds = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(buttonBounds.y).toBeGreaterThanOrEqual(plotBounds.y + plotBounds.height);
  }
  await page.setViewportSize(viewport);
  await expect(guided).toBeEnabled();
  await expect(page.getByLabel('Scramble', { exact: true })).not.toHaveText(scramble);
  await expect(page.getByText('Last solve', { exact: true })).toHaveCount(0);
  const previousTime = await page.getByLabel('Solve time', { exact: true }).innerText();
  expect(Number(previousTime)).toBeGreaterThan(0);
  expect(previousTime).toMatch(/^\d+\.\d{3}$/);
  await expect(page.locator('.trail-tip')).toHaveAttribute('style', 'left: 100%;');
  const trail = await page.locator('.trail-segment').evaluateAll(elements => elements.map(element => ({
    duration: Number(element.getAttribute('data-end')) - Number(element.getAttribute('data-start')),
    width: parseFloat((element as HTMLElement).style.width),
    phase: element.getAttribute('data-phase'),
  })));
  const durations = await page.locator('.trail-duration').evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-duration'))));
  // Chromium rounds percentages when serializing CSS styles.
  expect(trail.reduce((sum, segment) => sum + segment.width, 0)).toBeCloseTo(100, 3);
  expect(trail.every(segment => ['recognition', 'execution'].includes(segment.phase!))).toBe(true);
  const recognition = page.locator('.trail-segment.recognition').first();
  if (await recognition.count()) {
    await expect(recognition).toHaveCSS('background-image', 'none');
    await expect(recognition).toHaveCSS('filter', 'brightness(0.6)');
  }
  await expect(history.getByRole('row').nth(1).getByRole('cell').first()).toHaveText(`${previousTime}s`);
  await expect(statistics.getByRole('row', { name: /^Single / }).getByRole('cell')).toHaveText([previousTime, previousTime]);
  await expect.poll(async () => (await storedSolves(page)).map(solve => solve.status)).toEqual(['complete']);
  await expect(page.getByText('Saved locally', { exact: true })).toHaveCount(0);
  await expect(history.getByRole('row')).toHaveCount(2);
  await history.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Solve replay' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Solve replay' }).getByText('0/', { exact: false })).toContainText('0.000s');
  await page.getByRole('button', { name: 'Next move', exact: true }).click();
  await expect(page.getByLabel('Replay move')).toHaveValue('1');
  expect(await page.locator('.move-timeline button').first().getAttribute('title')).toBe('0.000s');
  await page.getByRole('button', { name: 'Close replay' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^timer-.*\.json$/);
  const csvPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Cubeast CSV' }).click();
  const csv = await csvPromise;
  expect(csv.suggestedFilename()).toMatch(/^timer-.*\.csv$/);
  const stream = await csv.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const [header, row] = Buffer.concat(chunks).toString('utf8').split('\r\n');
  expect(header.split(',')).toHaveLength(164);
  expect(row.split(',')).toHaveLength(164);
  expect(row).toContain('Simulated 3x3');
  const values = Object.fromEntries(header.split(',').map((column, i) => [column, row.split(',')[i]]));
  expect(values.solving_method).toBe('CFOP');
  expect(values.step_6_name).toBe('PLL');
  expect(values.step_6_cumulative_time).toBe(values.time);
  expect(durations).toEqual(Array.from({ length: 7 }, (_, i) => Number(values[`step_${i}_time`])));
  expect(trail.reduce((sum, segment) => sum + segment.duration, 0)).toBe(Number(values.time));
  expect(trail.filter(segment => segment.phase === 'recognition').reduce((sum, segment) => sum + segment.duration, 0)).toBe(Number(values.total_recognition_time));
  expect(trail.filter(segment => segment.phase === 'execution').reduce((sum, segment) => sum + segment.duration, 0)).toBe(Number(values.total_execution_time));
  expect(Array.from({ length: 7 }, (_, i) => Number(values[`step_${i}_time`])).reduce((a, b) => a + b, 0)).toBe(Number(values.time));
  expect(Array.from({ length: 7 }, (_, i) => Number(values[`step_${i}_face_turns`])).reduce((a, b) => a + b, 0)).toBe(Number(values.face_turns));
  for (let i = 0; i < 60; i++) {
    if (await page.getByRole('button', { name: 'Simulate solve', exact: true }).isEnabled()) break;
    await guided.click();
  }
  await expect(page.getByLabel('Solve time', { exact: true })).toHaveText(previousTime);
  await page.getByRole('button', { name: 'Simulate solve' }).click();
  await expect(history.getByRole('row')).toHaveCount(3);
  await expect(guided).toBeEnabled();
  await page.reload();
  await expect(history.getByRole('row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByLabel('Time precision', { exact: true })).toHaveValue('3');
  await page.getByRole('dialog', { name: 'Options', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByLabel('Solve time', { exact: true })).toHaveText('0.000');
  await expect(history.getByRole('row').nth(1).getByRole('cell').first()).toHaveText(/^\d+\.\d{3}s$/);
  const originalSingle = await statistics.getByRole('row', { name: /^Single / }).getByRole('cell').allTextContents();
  const backupChunks: Buffer[] = [];
  for await (const chunk of (await download.createReadStream())!) backupChunks.push(Buffer.from(chunk));
  const seed = (JSON.parse(Buffer.concat(backupChunks).toString('utf8')) as { solves: Solve[] }).solves[0];
  const solves = Array.from({ length: 1100 }, (_, i) => {
    const duration = i < 100 ? 30000 : 10000;
    return { ...seed, id: `statistics-${i}`, session: 'Statistics test', duration, createdAt: new Date(Date.UTC(2020, 0, 1) - i * 1000).toISOString(),
      moves: seed.moves.map(move => { const elapsed = move.elapsed * duration / seed.duration; return { ...move, elapsed, hostTime: seed.moves[0].hostTime + elapsed }; }) };
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Session', { exact: true }).fill('Statistics test');
  await page.getByRole('dialog', { name: 'Options', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(statistics.getByRole('cell')).toHaveText(Array(10).fill('--'));
  await page.locator('input[type=file]').setInputFiles({ name: 'statistics.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'timer-v1', solves })) });
  for (const name of ['Single', 'Ao5', 'Ao12', 'Ao100']) {
    await expect(statistics.getByRole('row', { name: new RegExp(`^${name} `) }).getByRole('cell')).toHaveText(['30.000', '10.000']);
  }
  await expect(statistics.getByRole('row', { name: /^Ao1000 / }).getByRole('cell')).toHaveText(['11.111', '10.000']);
  await expect(history.getByRole('row')).toHaveCount(101);
  await page.reload();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Session', { exact: true }).fill('Statistics test');
  await page.getByRole('dialog', { name: 'Options', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(statistics.getByRole('row', { name: /^Ao1000 / }).getByRole('cell')).toHaveText(['11.111', '10.000']);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Session', { exact: true }).fill('Default');
  await page.getByRole('dialog', { name: 'Options', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(statistics.getByRole('row', { name: /^Single / }).getByRole('cell')).toHaveText(originalSingle);
  expect(external).toEqual([]);
  expect(failures).toEqual([]);
});

test('options use a self-contained responsive dialog with keyboard dismissal and persistent settings', async ({ page }) => {
  await page.goto('');
  const options = page.getByRole('button', { name: 'Options', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Options', exact: true });
  const header = page.locator('header');
  const originalHeader = await header.boundingBox();
  await expect(page.getByLabel('Time precision', { exact: true })).toBeHidden();
  await expect(page.getByLabel('Session', { exact: true })).toBeHidden();
  await expect(page.getByLabel('Bluetooth MAC (only if needed)', { exact: true })).toBeHidden();
  await expect(page.getByRole('link', { name: "Find my cube's MAC address" })).toHaveCount(0);
  await options.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Session', { exact: true })).toHaveValue('Default');
  await expect(dialog.getByLabel('Bluetooth MAC (only if needed)', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: "Find my cube's MAC address" })).toBeVisible();
  expect(await header.boundingBox()).toEqual(originalHeader);
  await page.getByRole('button', { name: 'Connect cube', exact: true }).evaluate(button => (button as HTMLButtonElement).focus());
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(options).toBeFocused();
  await options.click();
  await dialog.getByLabel('Time precision', { exact: true }).selectOption('3');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(options).toBeFocused();
  await page.reload();
  await page.setViewportSize({ width: 375, height: 667 });
  await options.click();
  await expect(dialog.getByLabel('Time precision', { exact: true })).toHaveValue('3');
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(667);
  await dialog.getByRole('button', { name: 'Close options', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(options).toBeFocused();
});

test('rejects invalid backups without changing history', async ({ page }) => {
  await page.goto('');
  await expect(page.getByText('Try simulated cube', { exact: true })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({
    name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"timer-v1","solves":[null]}'),
  });
  await expect(page.getByRole('alert')).toContainText('Invalid solve');
  await expect(page.getByRole('table', { name: 'Solve history' }).getByRole('row')).toHaveCount(1);
});

test('reload preserves an interrupted solve as incomplete', async ({ page }) => {
  await page.goto('');
  await expect(page.getByText('Try simulated cube', { exact: true })).toBeEnabled();
  await page.getByText('Try simulated cube', { exact: true }).evaluate(button => (button as HTMLButtonElement).click());
  const guided = page.getByRole('button', { name: 'Perform guided move' });
  await expect(guided).toBeEnabled({ timeout: 45000 });
  for (let i = 0; i < 60; i++) {
    if (await page.getByRole('button', { name: 'Simulate solve', exact: true }).isEnabled()) break;
    await guided.click();
  }
  await page.getByRole('button', { name: 'U', exact: true }).click();
  await expect(page.getByText('1 reported moves recorded')).toBeVisible();
  await expect.poll(async () => (await storedSolves(page)).map(solve => [solve.status, solve.moves.length])).toEqual([['active', 1]]);
  await expect(page.getByText('Saved locally', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Options', exact: true }).getByLabel('Session', { exact: true })).toBeDisabled();
  await page.getByRole('dialog', { name: 'Options', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('table', { name: 'Solve history' }).getByRole('row')).toHaveCount(2);
  await page.getByRole('table', { name: 'Solve history' }).getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('section[aria-label="Solve replay"]')).toContainText('incomplete');
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
  await expect(page.getByText('Try simulated cube', { exact: true })).toBeEnabled();
  await page.getByText('Try simulated cube', { exact: true }).evaluate(button => (button as HTMLButtonElement).click());
  const guided = page.getByRole('button', { name: 'Perform guided move' });
  await expect(guided).toBeEnabled({ timeout: 45000 });
  for (let i = 0; i < 60; i++) {
    if (await page.getByRole('button', { name: 'Simulate solve', exact: true }).isEnabled()) break;
    await guided.click();
  }
  await page.getByRole('button', { name: 'U', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Storage quota exceeded');
  await expect(page.getByText('Not saved - export a backup now', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved locally', { exact: true })).toHaveCount(0);
});
