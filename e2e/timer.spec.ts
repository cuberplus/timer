import { test, expect, type Locator, type Page } from '@playwright/test';
import type { TwistyPlayer } from 'cubing/twisty';
import type { Solve } from '../src/engine';

async function expectAnimatedTurn(button: Locator, visualizer: string) {
  const animated = await button.evaluate(async (element, selector) => {
    const player = document.querySelector<TwistyPlayer>(selector)!;
    let partial = false;
    const observe = (info: { currentMoves: { fraction: number }[] }) => {
      partial ||= info.currentMoves.some(move => move.fraction > 0 && move.fraction < 1);
    };
    player.experimentalModel.currentMoveInfo.addFreshListener(observe);
    (element as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 300));
    player.experimentalModel.currentMoveInfo.removeFreshListener(observe);
    return partial;
  }, visualizer);
  expect(animated).toBe(true);
}

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

test('production manifest launches the timer and serves installable app icons', async ({ page }) => {
  await page.goto('');
  const manifestURL = await page.locator('link[rel="manifest"]').evaluate(link => (link as HTMLLinkElement).href);
  expect(new URL(manifestURL).pathname).toBe('/timer/manifest.webmanifest');
  const response = await page.request.get(manifestURL);
  expect(response.ok()).toBe(true);
  const manifest = await response.json() as {
    id: string; name: string; start_url: string; scope: string; display: string;
    icons: { src: string; sizes: string; type: string }[];
  };
  expect(manifest.name).toBe('CuberPlus - Timer');
  expect(manifest.display).toBe('standalone');
  for (const path of [manifest.id, manifest.start_url, manifest.scope]) expect(new URL(path, manifestURL).pathname).toBe('/timer/');
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(icon => icon.sizes === `${size}x${size}`)!;
    expect(icon.type).toBe('image/png');
    const dimensions = await page.evaluate(async url => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, new URL(icon.src, manifestURL).href);
    expect(dimensions).toEqual([size, size]);
  }
  const session = await page.context().newCDPSession(page);
  const { errors } = await session.send('Page.getAppManifest');
  expect(errors).toEqual([]);
  await session.detach();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Install app', exact: true })).toBeVisible();
});

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
  const refresh = page.getByRole('button', { name: 'New scramble', exact: true });
  await expect(refresh).toBeVisible();
  const previousScramble = await page.locator('.scramble-content').innerText();
  await refresh.click();
  await expect(page.locator('.scramble-content')).not.toHaveText(previousScramble, { timeout: 45000 });
  await expect(refresh).toBeEnabled();
  await expect(page.locator('.timer-panel .badge')).toHaveCount(0);
  await expect(page.locator('.timer-panel')).not.toContainText(/Follow the highlighted|Next:|Last solve|Use the cube's calibrated face/);
  const hasDoubleTurn = (await page.locator('.scramble .move').allTextContents()).some(move => move.endsWith('2'));
  const generatedMoves = await page.locator('.scramble .move').allTextContents();
  const hasCommutingPair = generatedMoves.some((move, i) => i > 0 && ['UD', 'RL', 'FB'].some(axis => axis.includes(move[0]) && axis.includes(generatedMoves[i - 1][0])));
  for (let i = 1; i < generatedMoves.length; i++) {
    expect(generatedMoves[i][0]).not.toBe(generatedMoves[i - 1][0]);
    if (i >= 2 && ['UD', 'RL', 'FB'].some(axis => axis.includes(generatedMoves[i][0]) && axis.includes(generatedMoves[i - 1][0]))) {
      expect(generatedMoves[i][0]).not.toBe(generatedMoves[i - 2][0]);
    }
  }
  const first = (await page.locator('.scramble .current').innerText())[0];
  const liveCube = page.locator('.timer-panel twisty-player');
  await expect.poll(() => liveCube.evaluate(element => (element as TwistyPlayer).experimentalModel.twistySceneModel.hintFacelet.get())).toBe('none');
  await expectAnimatedTurn(page.getByRole('button', { name: first === 'R' || first === 'L' ? 'F' : 'R', exact: true }), '.timer-panel twisty-player');
  await expect(page.getByText('Wrong turn.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Correction moves', exact: true })).toBeVisible();
  await expect(page.locator('.scramble .move:not(.done):not(.correction)')).toHaveCount(0);
  await expect(page.locator('.scramble .current.correction')).toHaveCSS('background-color', 'rgb(220, 53, 69)');
  let checkedPartial = false;
  let checkedCommuting = false;
  let checkedCommutingDouble = false;
  for (let i = 0; i < 60; i++) {
    if (await page.getByRole('button', { name: 'Simulate solve', exact: true }).isEnabled()) break;
    const current = page.locator('.scramble .current:not(.correction)');
    if (!checkedCommuting && await current.count()) {
      const second = await current.evaluate(element => {
        const next = element.nextElementSibling;
        return next?.matches('.move:not(.done)') && ['UD', 'RL', 'FB'].some(axis => axis.includes(element.textContent![0]) && axis.includes(next.textContent![0])) ? next.textContent : null;
      });
      if (second) {
        const firstPending = await current.innerText();
        const button = page.getByRole('button', { name: second.includes('2') ? second[0] : second, exact: true });
        await button.click();
        if (second.includes('2')) {
          await expect(current).toHaveText(firstPending);
          const partial = current.locator('xpath=following-sibling::span[1]');
          await expect(partial).not.toHaveClass(/done/);
          await expect(partial).toHaveClass(/partial/);
          await expect(partial).toHaveCSS('background-color', 'rgb(245, 185, 66)');
          await expect(partial).toHaveAttribute('title', 'Partially complete');
          checkedCommutingDouble = true;
          await button.click();
        }
        await expect(current).toHaveText(firstPending);
        await expect(page.getByRole('group', { name: 'Correction moves', exact: true })).toHaveCount(0);
        const completed = current.locator('xpath=following-sibling::span[1]');
        await expect(completed).toHaveText(second);
        await expect(completed).toHaveClass(/done/);
        await expect(completed).toHaveCSS('color', 'rgb(101, 211, 176)');
        checkedCommuting = true;
      }
    }
    if (!checkedPartial && await current.count() && (await current.innerText()).endsWith('2')) {
      await page.getByRole('button', { name: (await current.innerText())[0], exact: true }).click();
      await expect(current).toHaveClass(/partial/);
      await expect(current).toHaveCSS('background-color', 'rgb(245, 185, 66)');
      checkedPartial = true;
    }
    await guided.click();
  }
  expect(checkedPartial || checkedCommutingDouble).toBe(hasDoubleTurn);
  expect(checkedCommuting).toBe(hasCommutingPair);
  await expect(page.getByRole('button', { name: 'Simulate solve', exact: true })).toBeEnabled();
  await expect(page.locator('.timer-panel')).not.toContainText(/Turn .+ once more|Scramble complete\./);
  await expect(page.getByLabel('Solve time', { exact: true })).toHaveText('0.00');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Time precision', { exact: true }).selectOption('3');
  await page.getByRole('dialog', { name: 'Options', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByLabel('Solve time', { exact: true })).toHaveText('0.000');
  await expect(page.locator('.timer-panel').getByLabel('Inspection time', { exact: true })).toHaveCount(0);
  const scramble = await page.getByLabel('Scramble', { exact: true }).innerText();
  const initialViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.locator('.timer-panel').evaluate(element =>
    element.querySelector('[role="img"]')!.getBoundingClientRect().top - element.querySelector('.timer-value')!.getBoundingClientRect().bottom,
  )).toBeLessThanOrEqual(50);
  const scrambleLayout = await page.getByLabel('Scramble', { exact: true }).evaluate(element => ({
    height: element.getBoundingClientRect().height,
    width: element.getBoundingClientRect().width,
    rowOffset: element.nextElementSibling!.getBoundingClientRect().top - element.getBoundingClientRect().top,
    timerOffset: document.querySelector('.timer-value')!.getBoundingClientRect().top - element.getBoundingClientRect().top,
    cubeOffset: document.querySelector('.timer-panel [role="img"]')!.getBoundingClientRect().top - element.getBoundingClientRect().top,
  }));
  await page.getByRole('button', { name: 'Simulate solve' }).click();
  await expect(page.locator('.scramble-placeholder [role="status"]')).toHaveText('Scrambles hidden while solving');
  await expect(page.locator('.scramble-placeholder').getByRole('button', { name: 'Abort solve', exact: true })).toBeVisible();
  await expect(page.getByText('reported moves recorded', { exact: false })).toHaveCount(0);
  await expect(page.locator('.scramble-placeholder')).toBeVisible();
  await expect(page.locator('.timer-panel .scramble-content')).toBeHidden();
  await expect(page.locator('[aria-label="New scramble"]')).toBeHidden();
  await expect(page.locator('[aria-label="New scramble"]')).toBeDisabled();
  expect(await page.getByLabel('Scramble', { exact: true }).evaluate(element => ({
    height: element.getBoundingClientRect().height,
    width: element.getBoundingClientRect().width,
    rowOffset: element.nextElementSibling!.getBoundingClientRect().top - element.getBoundingClientRect().top,
    timerOffset: document.querySelector('.timer-value')!.getBoundingClientRect().top - element.getBoundingClientRect().top,
    cubeOffset: document.querySelector('.timer-panel [role="img"]')!.getBoundingClientRect().top - element.getBoundingClientRect().top,
  }))).toEqual(scrambleLayout);
  await page.setViewportSize(initialViewport);
  await expect(page.getByRole('group', { name: 'Solve timeline', exact: true })).toBeVisible();
  await expect.poll(async () => parseFloat(await page.locator('.trail-tip').evaluate(element => (element as HTMLElement).style.left))).toBeGreaterThan(0);
  await expect(page.getByRole('group', { name: 'CFOP steps' })).toBeVisible();
  await expect(page.locator('.trail-duration[data-status="pending"]:not([data-step="f2l"])')).toHaveCount(1);
  await expect(history.getByRole('row')).toHaveCount(2);
  const celebration = page.getByRole('status', { name: 'Personal best', exact: true });
  await expect(celebration).toBeVisible();
  await expect(celebration).toContainText(/Single: \d+\.\d{3}s/);
  await expect(celebration.locator('.pb-disco-ball')).toHaveCSS('animation-duration', '1.4s');
  await expect(celebration.locator('.pb-disco-ball')).toHaveCSS('animation-iteration-count', 'infinite');
  await expect(celebration).toHaveCSS('position', 'fixed');
  await expect(celebration).toHaveCSS('pointer-events', 'none');
  await expect(history.getByRole('columnheader')).toHaveText(['Solve number', 'Time', 'Turns', 'TPS', 'View']);
  for (const [i, name] of ['Cross', 'F2L Pair 1', 'F2L Pair 2', 'F2L Pair 3', 'F2L Pair 4', 'OLL', 'PLL'].entries()) {
    const label = page.locator(`.trail-duration[data-step="${i}"]`);
    await expect(label).toBeVisible();
    await expect(label).toHaveAttribute('data-status', 'done');
    await expect(label).toHaveText(/\d+\.\d{3}s$/);
    await expect(label).toHaveAttribute('aria-label', new RegExp(`^${name}: `));
  }
  await expect(page.getByRole('group', { name: 'CFOP steps' }).locator('.trail-duration strong')).toHaveText(['Cross', 'F2L', 'OLL', 'PLL']);
  await expect(page.getByRole('group', { name: 'F2L sub-times' }).locator('.trail-duration strong')).toHaveText(['F2L 1', 'F2L 2', 'F2L 3', 'F2L 4']);
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
  await expect(page.locator('.scramble-placeholder')).toHaveCount(0);
  await expect(page.locator('.timer-panel .scramble-content')).toBeVisible();
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
  const durations = await page.locator('.trail-duration:not([data-step="f2l"])').evaluateAll(elements => elements
    .sort((a, b) => Number(a.getAttribute('data-step')) - Number(b.getAttribute('data-step')))
    .map(element => Number(element.getAttribute('data-duration'))));
  await expect(page.locator('.trail-duration[data-step="f2l"]')).toHaveAttribute('data-duration', String(durations.slice(1, 5).reduce((sum, duration) => sum + duration, 0)));
  // Chromium rounds percentages when serializing CSS styles.
  expect(trail.reduce((sum, segment) => sum + segment.width, 0)).toBeCloseTo(100, 3);
  expect(trail.every(segment => ['recognition', 'execution'].includes(segment.phase!))).toBe(true);
  const recognition = page.locator('.trail-segment.recognition').first();
  if (await recognition.count()) {
    await expect(recognition).toHaveCSS('background-image', 'none');
    await expect(recognition).toHaveCSS('filter', 'brightness(0.6)');
  }
  await expect(history.getByRole('row').nth(1).getByRole('cell').first()).toHaveText('1');
  await expect(history.getByRole('row').nth(1).getByRole('cell').nth(1)).toHaveText(`${previousTime}s`);
  await expect(statistics.getByRole('row', { name: /^Single / }).getByRole('cell')).toHaveText([previousTime, previousTime]);
  await expect.poll(async () => (await storedSolves(page)).map(solve => solve.status)).toEqual(['complete']);
  const recorded = (await storedSolves(page))[0];
  expect(recorded.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(recorded.inspection).toBeGreaterThanOrEqual(0);
  await expect(page.getByText('Saved locally', { exact: true })).toHaveCount(0);
  await expect(history.getByRole('row')).toHaveCount(2);
  await history.getByRole('button', { name: 'View', exact: true }).click();
  const replay = page.getByRole('dialog', { name: 'Solve replay' });
  await expect(replay).toBeVisible();
  await expect(replay.getByLabel('Solve ID', { exact: true })).toHaveText(`Solve ID: ${recorded.id}`);
  await expect(replay.getByLabel('Inspection time', { exact: true })).toHaveText(`Inspection: ${(recorded.inspection! / 1000).toFixed(3)}s`);
  expect(await replay.evaluate(element => element.lastElementChild!.getAttribute('aria-label'))).toBe('Solve ID');
  expect(await replay.evaluate(element => element.matches(':modal'))).toBe(true);
  const replayBounds = (await replay.boundingBox())!, screen = page.viewportSize()!;
  expect(replayBounds.x + replayBounds.width / 2).toBeCloseTo(screen.width / 2, 0);
  expect(replayBounds.y + replayBounds.height / 2).toBeCloseTo(screen.height / 2, 0);
  const replayCube = replay.locator('twisty-player');
  await expect.poll(() => replayCube.evaluate(element => (element as TwistyPlayer).experimentalModel.twistySceneModel.hintFacelet.get())).toBe('none');
  await expect(page.locator('.replay-step-name')).toHaveText(['Cross', 'F2L Pair 1', 'F2L Pair 2', 'F2L Pair 3', 'F2L Pair 4', 'OLL', 'PLL']);
  await expect(page.locator('.replay-step-name').first()).toHaveCSS('color', 'rgb(159, 200, 255)');
  await expect(page.locator('.move-timeline .current')).toHaveCount(1);
  await expect(replay.getByText('0/', { exact: false })).toContainText('0.000s');
  await expectAnimatedTurn(page.getByRole('button', { name: 'Next move', exact: true }), '.replay-dialog twisty-player');
  await expect(page.getByLabel('Replay move')).toHaveValue('1');
  await expect(page.locator('.move-timeline button').first()).toHaveClass(/\bcurrent\b/);
  expect(await page.locator('.move-timeline button').first().getAttribute('title')).toBe('0.000s');
  await expectAnimatedTurn(page.getByRole('button', { name: 'Previous move', exact: true }), '.replay-dialog twisty-player');
  await page.locator('.move-timeline button').last().click();
  await expect.poll(() => replayCube.evaluate(async element =>
    (await (element as TwistyPlayer).experimentalModel.currentPattern.get()).experimentalIsSolved({ ignoreCenterOrientation: true, ignorePuzzleOrientation: true }),
  )).toBe(true);
  await page.setViewportSize({ width: 375, height: 900 });
  await expect.poll(async () => replay.evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && element.scrollHeight > element.clientHeight;
  })).toBe(true);
  await page.setViewportSize(viewport);
  await page.keyboard.press('Escape');
  await expect(replay).toHaveCount(0);
  await expect(history.getByRole('button', { name: 'View', exact: true })).toBeFocused();
  await history.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('button', { name: 'Close replay' }).click();
  await expect(celebration).toBeVisible();
  await expect(celebration.locator('.pb-disco-ball')).toHaveCSS('animation-iteration-count', 'infinite');
  await expect(celebration.getByRole('button', { name: 'Dismiss personal best' })).toHaveCSS('pointer-events', 'auto');
  await celebration.getByRole('button', { name: 'Dismiss personal best' }).click();
  await expect(celebration).toHaveCount(0);
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
  expect(values.inspection_time).toBe(String(Math.round(recorded.inspection!)));
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
  await expect(history.getByRole('row').nth(1).getByRole('cell').nth(1)).toHaveText(/^\d+\.\d{3}s$/);
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
  const penalized: Solve = { ...seed, id: 'penalty-example', session: 'Penalties test', penalty: 2000 };
  const dnf: Solve = { ...seed, id: 'dnf-example', session: 'Penalties test', status: 'incomplete', reason: 'Solve aborted by user.' };
  await page.locator('input[type=file]').setInputFiles({ name: 'penalties.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'timer-v1', solves: [penalized, dnf] })) });
  await page.reload();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Session', { exact: true }).fill('Penalties test');
  await page.getByRole('dialog', { name: 'Options', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  const plusTwo = history.locator('.solve-penalty').filter({ hasText: '+2' });
  await expect(plusTwo).toBeVisible();
  await expect(plusTwo).toHaveCSS('background-color', 'rgb(255, 193, 7)');
  await expect(plusTwo.locator('..')).toHaveText(`${((seed.duration + 2000) / 1000).toFixed(3)}s +2`);
  await expect(history.locator('.solve-penalty').filter({ hasText: 'DNF' })).toHaveCSS('background-color', 'rgb(220, 53, 69)');
  await plusTwo.locator('..').locator('..').getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Solve replay' }).getByLabel('Penalty reason', { exact: true })).toHaveText('+2 reason: over-turn');
  await page.getByRole('button', { name: 'Close replay', exact: true }).click();
  await expect(page.locator('[aria-label="Penalty reason"]')).toHaveCount(0);
  await history.locator('.solve-penalty').filter({ hasText: 'DNF' }).locator('..').locator('..').getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Solve replay' }).getByLabel('Penalty reason', { exact: true })).toHaveText('DNF reason: solve aborted');
  await page.getByRole('button', { name: 'Close replay', exact: true }).click();
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
  await expect(dialog.getByLabel('Extra-turn +2 penalty', { exact: true })).toBeChecked();
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
  await dialog.getByLabel('Extra-turn +2 penalty', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(options).toBeFocused();
  await page.reload();
  await page.setViewportSize({ width: 375, height: 667 });
  await options.click();
  await expect(dialog.getByLabel('Time precision', { exact: true })).toHaveValue('3');
  await expect(dialog.getByLabel('Extra-turn +2 penalty', { exact: true })).not.toBeChecked();
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

test('hide distracting visuals persists and animates zero to three dots without moving Solving', async ({ page }) => {
  await page.goto('');
  const options = page.getByRole('dialog', { name: 'Options', exact: true });
  const setting = options.getByRole('checkbox', { name: 'Hide distracting visuals', exact: true });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(options.getByText('Hide all', { exact: true })).toHaveCount(0);
  await expect(options.locator('details')).not.toHaveAttribute('open', '');
  await setting.check();
  await expect(options.locator('details')).not.toHaveAttribute('open', '');
  const heading = options.getByText('Hide distracting visuals', { exact: true });
  const checkboxBounds = (await setting.boundingBox())!;
  const headingBounds = (await heading.boundingBox())!;
  expect(checkboxBounds.x + checkboxBounds.width).toBeLessThan(headingBounds.x);
  await setting.uncheck();
  await options.getByText('Hide distracting visuals', { exact: true }).click();
  await expect(options.locator('details')).toHaveAttribute('open', '');
  await expect(setting).not.toBeChecked();
  await setting.check();
  const cubeSetting = options.getByRole('checkbox', { name: 'Cube', exact: true });
  await cubeSetting.uncheck();
  expect(await setting.evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(true);
  await options.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await page.setViewportSize({ width: 375, height: 667 });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await options.getByText('Hide distracting visuals', { exact: true }).click();
  await expect(options.getByRole('checkbox', { name: 'Timer', exact: true })).toBeChecked();
  await expect(cubeSetting).not.toBeChecked();
  await expect(options.getByRole('checkbox', { name: 'Progress bar', exact: true })).toBeChecked();
  expect(await setting.evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(true);
  await setting.check();
  await expect(cubeSetting).toBeChecked();
  await options.getByRole('button', { name: 'Done', exact: true }).click();
  const simulator = page.getByText('Try simulated cube', { exact: true });
  await expect(simulator).toBeEnabled();
  await simulator.evaluate(button => (button as HTMLButtonElement).click());
  const guided = page.getByRole('button', { name: 'Perform guided move' });
  await expect(guided).toBeEnabled({ timeout: 45000 });
  for (let i = 0; i < 60; i++) {
    if (await page.getByRole('button', { name: 'Simulate solve', exact: true }).isEnabled()) break;
    await guided.click();
  }
  await expect(page.getByLabel('Solve time', { exact: true })).toBeVisible();
  await expect(page.locator('.timer-panel twisty-player')).toBeVisible();
  await page.getByRole('button', { name: 'U', exact: true }).click();
  const indicator = page.getByRole('status', { name: 'Solving', exact: true });
  await expect(indicator).toBeVisible();
  await expect(page.getByLabel('Solve time', { exact: true })).toHaveCount(0);
  await expect(page.locator('.timer-panel twisty-player')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Solve timeline', exact: true })).toHaveCount(0);
  const samples = await indicator.evaluate(element => {
    const word = element.firstElementChild!;
    const dots = element.querySelector<HTMLElement>('.solving-dots > span')!;
    const animation = dots.getAnimations()[0];
    animation.pause();
    const samples = [200, 600, 1000, 1400, 1800].map(time => {
      animation.currentTime = time;
      return {
        dots: Math.round(3 * dots.getBoundingClientRect().width / dots.parentElement!.getBoundingClientRect().width),
        wordX: word.getBoundingClientRect().x,
        wordWidth: word.getBoundingClientRect().width,
      };
    });
    animation.play();
    return samples;
  });
  expect(samples.map(sample => sample.dots)).toEqual([0, 1, 2, 3, 0]);
  expect(samples.every(sample => sample.wordX === samples[0].wordX && sample.wordWidth === samples[0].wordWidth)).toBe(true);
  for (const name of ['Timer', 'Cube', 'Progress bar']) {
    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await setting.uncheck();
    await options.getByRole('checkbox', { name, exact: true }).check();
    expect(await setting.evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(true);
    await options.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByLabel('Solve time', { exact: true })).toHaveCount(name === 'Timer' ? 0 : 1);
    await expect(indicator).toHaveCount(name === 'Timer' ? 1 : 0);
    await expect(page.locator('.timer-panel twisty-player')).toHaveCount(name === 'Cube' ? 0 : 1);
    await expect(page.getByRole('group', { name: 'Solve timeline', exact: true })).toHaveCount(name === 'Progress bar' ? 0 : 1);
    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await setting.check();
    await options.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(indicator).toBeVisible();
    await expect(page.getByLabel('Solve time', { exact: true })).toHaveCount(0);
    await expect(page.locator('.timer-panel twisty-player')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Solve timeline', exact: true })).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await setting.uncheck();
  await options.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(indicator).toHaveCount(0);
  await expect(page.getByLabel('Solve time', { exact: true })).toBeVisible();
  await expect(page.locator('.timer-panel twisty-player')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Solve timeline', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await setting.check();
  await options.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(indicator).toBeVisible();
  await page.getByRole('button', { name: 'Abort solve', exact: true }).click();
  await expect(indicator).toHaveCount(0);
  await expect(page.getByLabel('Solve time', { exact: true })).toBeVisible();
  await expect(page.locator('.timer-panel twisty-player')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Solve timeline', exact: true })).toBeVisible();
  await expect.poll(async () => (await storedSolves(page)).map(solve => [solve.status, solve.reason, solve.moves.length])).toEqual([['incomplete', 'Solve aborted by user.', 1]]);
  const dnfBadge = page.locator('.timer-display .solve-penalty');
  await expect(dnfBadge).toHaveText('DNF');
  await expect(dnfBadge).toHaveCSS('background-color', 'rgb(220, 53, 69)');
  const timeBox = await page.getByLabel('Solve time', { exact: true }).boundingBox();
  const badgeBox = await dnfBadge.boundingBox();
  expect(badgeBox!.x).toBeGreaterThan(timeBox!.x + timeBox!.width);
  await expect(page.getByRole('table', { name: 'Solve history' }).locator('.solve-penalty')).toHaveText('DNF');
  await expect(page.getByText('Return the cube to solved', { exact: true })).toBeVisible({ timeout: 45000 });
  await expect(page.getByRole('button', { name: 'New scramble', exact: true })).toBeDisabled();
  const dnf = (await storedSolves(page))[0];
  for (let i = 0; i < 80; i++) {
    if (!await page.getByText('Return the cube to solved', { exact: true }).isVisible()) break;
    await page.getByRole('button', { name: 'Perform guided move', exact: true }).click();
  }
  await expect(page.getByText('Return the cube to solved', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New scramble', exact: true })).toBeEnabled({ timeout: 45000 });
  await expect(page.locator('.scramble-content .move')).not.toHaveCount(0);
  expect(await storedSolves(page)).toEqual([dnf]);
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
  await expect(page.locator('.scramble-placeholder').getByRole('button', { name: 'Abort solve', exact: true })).toBeVisible();
  await expect.poll(async () => (await storedSolves(page)).map(solve => [solve.status, solve.moves.length])).toEqual([['active', 1]]);
  await expect(page.getByText('Saved locally', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Options', exact: true }).getByLabel('Session', { exact: true })).toBeDisabled();
  await page.getByRole('dialog', { name: 'Options', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('table', { name: 'Solve history' }).getByRole('row')).toHaveCount(2);
  await page.getByRole('table', { name: 'Solve history' }).getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Solve replay' })).toContainText('incomplete');
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
