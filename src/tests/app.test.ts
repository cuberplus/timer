/** @jest-environment jsdom */
import { jest } from '@jest/globals';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import type { SmartCubeEvent } from 'smartcube-web-bluetooth';
import type { Solve } from '../engine';
import { averageDetails, newPersonalBests, numberedSolves, personalBestNotifications, sessionStats } from '../storage';
import { loadCube, SOLVED, Cube, inverse, isMove, movesOf, locations, sameAxis, simplifyMoves } from '../puzzle';

const cube = await loadCube();
const generate = jest.fn<() => Promise<string>>();
const save = jest.fn<(solves: Solve[]) => Promise<void>>().mockResolvedValue();
let recovered: Solve[] = [];
let emit: (event: SmartCubeEvent) => void;
let physicalFacelets = SOLVED, physicalSerial: number | undefined;
await jest.unstable_mockModule('../puzzle', () => ({ Cube, SOLVED, inverse, isMove, movesOf, locations, sameAxis, simplifyMoves, loadCube: async () => cube, generateScramble: generate }));
await jest.unstable_mockModule('../bluetooth', () => ({ BluetoothCube: class {
  connection: { deviceName: string } | null = null;
  async connect(_mac: string, events: typeof emit, ready: (device: { deviceName: string }) => void) {
    emit = events;
    physicalFacelets = SOLVED; physicalSerial = undefined;
    this.connection = { deviceName: 'Test cube' };
    ready(this.connection);
    emit({ type: 'FACELETS', timestamp: 0, facelets: SOLVED });
  }
  async disconnect() { this.connection = null; }
  async refresh() { emit({ type: 'FACELETS', timestamp: 0, facelets: physicalFacelets, serial: physicalSerial }); }
} }));
await jest.unstable_mockModule('../storage', () => ({
  saveSolves: save, readSolves: async () => recovered, backupJSON: () => '', validateBackup: () => recovered,
  cubeastCSV: () => '', averageDetails, newPersonalBests, numberedSolves, personalBestNotifications, sessionStats, turns: (solve: Solve) => solve.moves.length,
  formatTime: (ms: number, precision: 2 | 3 = 2) => (ms / 1000).toFixed(precision),
}));
await jest.unstable_mockModule('../CubeView', () => ({
  CubeView: ({ facelets }: { facelets: string }) => createElement('div', { role: 'img', 'aria-label': 'Live 3x3 cube state', 'data-facelets': facelets }),
}));
await jest.unstable_mockModule('../Replay', () => ({
  Replay: ({ solve, close }: { solve: Solve; close: () => void }) => createElement('div', { 'aria-label': 'Solve replay', 'data-solve-id': solve.id },
    createElement('button', { onClick: close }, 'Close replay')),
}));
const { default: App } = await import('../App');

let root: Root, container: HTMLDivElement, resolveNext: (scramble: string) => void, rejectNext: (error: Error) => void;
beforeEach(async () => {
  recovered = [];
  physicalFacelets = SOLVED; physicalSerial = undefined;
  localStorage.removeItem('timer-time-precision');
  localStorage.removeItem('timer-over-turn-penalty');
  localStorage.removeItem('timer-pb-daily-records');
  localStorage.removeItem('timer-show-every-long-pb');
  localStorage.removeItem('timer-hide-distracting-visuals');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value: <T>(value: T): T => deserialize(serialize(value)) as T });
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => webcrypto.randomUUID() });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: jest.fn(() => ({ matches: false })) });
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: {} });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(performance, 'now').mockReturnValue(0);
  jest.spyOn(cube, 'solution').mockImplementation(async facelets => {
    const alg = ['R', "R U'", 'R U2'].find(alg => cube.facelets(cube.solved().applyAlg(alg)) === facelets);
    if (!alg) throw new Error('Unexpected cube state in test recovery.');
    return movesOf(alg).reverse().map(inverse);
  });
  save.mockClear(); generate.mockReset();
  generate.mockResolvedValueOnce('R U2').mockImplementationOnce(() => new Promise<string>((resolve, reject) => { resolveNext = resolve; rejectNext = reject; })).mockResolvedValue('B R2');
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(App)); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.useRealTimers(); jest.restoreAllMocks(); });

async function click(name: string) {
  const button = Array.from(container.querySelectorAll('button')).find(element => element.textContent === name || element.getAttribute('aria-label') === name);
  expect(button).toBeDefined(); expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}
function move(notation: string, hostTime: number, serial?: number) {
  jest.mocked(performance.now).mockReturnValue(hostTime);
  physicalFacelets = cube.facelets(cube.parse(physicalFacelets).applyMove(notation)); physicalSerial = serial;
  emit({ type: 'MOVE', timestamp: hostTime, move: notation, face: 0, direction: 0, localTimestamp: hostTime, cubeTimestamp: null, serial });
}
async function finishFirst() {
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); move('U2', 300); move("R'", 900); });
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.60');
  expect(generate).toHaveBeenCalledTimes(2);
  expect(container.querySelector('.trail-duration[data-step="6"][data-status="done"]')).not.toBeNull();
}

async function showHistory(solves: Solve[]) {
  await act(async () => root.unmount());
  recovered = solves;
  root = createRoot(container);
  await act(async () => root.render(createElement(App)));
}
function historySolve(number: number, duration: number, count: number, session = 'Default', status: Solve['status'] = 'complete'): Solve {
  return {
    version: 1, id: String(number), session, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString(),
    device: 'Test cube', scramble: 'R', startFacelets: SOLVED, duration, status, reason: '', timingBasis: 'host',
    moves: Array.from({ length: count }, () => ({ move: 'R', hostTime: 0, elapsed: 0, localTimestamp: null, cubeTimestamp: null })), orientations: [],
  };
}
function historyNumbers() {
  return Array.from(container.querySelectorAll('[aria-label="Solve history"] tbody tr')).map(row => Number(row.firstElementChild!.textContent));
}

async function timedApp(solves: Solve[] = []) {
  await act(async () => root.unmount());
  recovered = solves;
  jest.useFakeTimers({ doNotFake: ['performance'] });
  root = createRoot(container);
  await act(async () => root.render(createElement(App)));
}

test('new PB celebrations wait for the penalty window and stay until dismissed without shifting the timer', async () => {
  await timedApp();
  await finishFirst();
  await act(async () => jest.advanceTimersByTime(500));
  expect(container.querySelector('[aria-label="Personal best"]')).toBeNull();
  await act(async () => jest.advanceTimersByTime(1));
  const celebration = container.querySelector('[aria-label="Personal best"]')!;
  expect(celebration.textContent).toContain('New personal best!');
  expect(celebration.textContent).toContain('Single: 0.60s');
  expect(celebration.querySelector('.pb-disco-ball')).not.toBeNull();
  expect(celebration.closest('.timer-panel')).toBeNull();
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.60');
  await act(async () => jest.advanceTimersByTime(60000));
  expect(container.querySelector('[aria-label="Personal best"]')).not.toBeNull();
  await click('Dismiss personal best');
  expect(container.querySelector('[aria-label="Personal best"]')).toBeNull();
});

test('simultaneous PBs have separate clickable notifications and dismissal does not open details', async () => {
  const previous = [12000, 14000, 16000, 18000, 20000].map((duration, i) => historySolve(5 - i, duration, 2));
  await timedApp(previous);
  await finishFirst();
  await act(async () => jest.advanceTimersByTime(501));
  const celebrations = container.querySelectorAll('[aria-label="Personal best"]');
  expect(celebrations).toHaveLength(2);
  expect(celebrations[0].textContent).toContain('Single: 0.60s');
  expect(celebrations[1].textContent).toContain('Ao5: 14.00s');
  await click('View PB Single');
  expect(container.querySelector('[aria-label="Solve replay"]')?.getAttribute('data-solve-id')).toBe(save.mock.calls.at(-1)![0][0].id);
  await click('Close replay');
  await click('Dismiss personal best');
  expect(container.querySelector('[aria-label="Solve replay"]')).toBeNull();
  expect(container.querySelector('[aria-label="Personal best"]')?.textContent).toContain('Ao5:');
  await click('View PB Ao5');
  expect(container.querySelector<HTMLDialogElement>('.average-dialog')?.open).toBe(true);
  const rows = container.querySelectorAll('[aria-label="Average solves"] tbody tr');
  expect(Array.from(container.querySelectorAll('[aria-label="Average solves"] thead th'), cell => cell.textContent)).toEqual(['Solve', 'Time', 'View']);
  expect(Array.from(rows, row => row.children[0].textContent)).toEqual(['2', '3', '4', '5', '6']);
  expect(Array.from(rows, row => row.children[1].textContent)).toEqual(['(18.00s)', '16.00s', '14.00s', '12.00s', '(0.60s)']);
  expect(rows[0].querySelector('s')?.className).toBe('average-trimmed-worst');
  expect(rows[4].querySelector('s')?.className).toBe('average-trimmed-best');
  await click('View average solve 6');
  expect(container.querySelector('[aria-label="Solve replay"]')?.getAttribute('data-solve-id')).toBe(save.mock.calls.at(-1)![0][0].id);
  await click('Close replay');
  expect(container.querySelector<HTMLDialogElement>('.average-dialog')?.open).toBe(true);
  await act(async () => container.querySelector('.average-dialog')!.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true })));
  expect(container.querySelector('.average-dialog')).toBeNull();
  await click('Dismiss personal best');
  expect(container.querySelector('[aria-label="Personal best"]')).toBeNull();
  expect(container.querySelector('.average-dialog')).toBeNull();
});

test('successive PBs stay separately visible, while long-average notices reset at local midnight', async () => {
  const previous = Array.from({ length: 999 }, (_, i) => historySolve(999 - i, 10000 + i * 1000, 2));
  await timedApp(previous);
  jest.setSystemTime(new Date(2026, 10, 1, 23, 59, 30));
  await finishFirst();
  await act(async () => jest.advanceTimersByTime(501));
  expect(container.querySelector('[aria-label="Personal best"]')?.textContent).toContain('Single: 0.60s');
  for (const name of ['Ao5', 'Ao12', 'Ao100', 'Ao1000']) {
    expect(container.querySelector('[aria-label="Personal best notifications"]')?.textContent).toContain(`${name}:`);
  }
  expect(container.querySelectorAll('[aria-label="Personal best"]')).toHaveLength(5);
  await act(async () => resolveNext('F L2'));
  await act(async () => { move('F', 2000); move('L2', 2100); move('L2', 2200); move("F'", 2400); });
  await act(async () => jest.advanceTimersByTime(501));
  expect(container.querySelector('[aria-label="Personal best"]')?.textContent).toContain('Single: 0.60s');
  await act(async () => jest.advanceTimersByTime(60000));
  expect(container.querySelector('[aria-label="Personal best"]')?.textContent).toContain('Single: 0.60s');
  const notices = container.querySelectorAll('[aria-label="Personal best"]');
  expect(notices).toHaveLength(8);
  const second = notices[5];
  expect(second.textContent).toContain('Single: 0.20s');
  expect(notices[6].textContent).toContain('Ao5:');
  expect(notices[7].textContent).toContain('Ao12:');
  expect(JSON.parse(localStorage.getItem('timer-pb-daily-records')!)).toEqual({ date: '2026-11-01', records: ['Ao100', 'Ao1000'] });

  jest.setSystemTime(new Date(2026, 10, 2, 0, 0, 1));
  await act(async () => { move('B', 3000); move('R2', 3100); move('R2', 3200); move("B'", 3300); });
  await act(async () => jest.advanceTimersByTime(501));
  const allNotices = container.querySelectorAll('[aria-label="Personal best"]');
  expect(allNotices).toHaveLength(13);
  expect(allNotices[5]).toBe(second);
  const third = allNotices[8];
  expect(third.textContent).toContain('Single: 0.10s');
  expect(allNotices[11].textContent).toContain('Ao100:');
  expect(allNotices[12].textContent).toContain('Ao1000:');
  expect(JSON.parse(localStorage.getItem('timer-pb-daily-records')!)).toEqual({ date: '2026-11-02', records: ['Ao100', 'Ao1000'] });
  while (container.querySelector('[aria-label="Personal best"]')) await click('Dismiss personal best');
  expect(container.querySelector('[aria-label="Personal best"]')).toBeNull();
});

test.each([
  ['{"date":"2026-11-01","records":["Ao100"]}', false, true],
  ['{"date":"2026-11-01","records":["Ao100","Ao1000"]}', false, false],
  ['{"date":"2026-10-31","records":["Ao100","Ao1000"]}', true, true],
  ['invalid JSON', true, true],
])('daily PB limits restore safely from %s', async (saved, ao100, ao1000) => {
  await timedApp(Array.from({ length: 999 }, (_, i) => historySolve(999 - i, 10000 + i * 1000, 2)));
  jest.setSystemTime(new Date(2026, 10, 1, 12));
  localStorage.setItem('timer-pb-daily-records', saved);
  await finishFirst();
  await act(async () => jest.advanceTimersByTime(501));
  const text = container.querySelector('[aria-label="Personal best notifications"]')!.textContent!;
  expect(text).toContain('Single: 0.60s');
  expect(text).toContain('Ao5:');
  expect(text).toContain('Ao12:');
  expect(text.includes('Ao100:')).toBe(ao100);
  expect(text.includes('Ao1000:')).toBe(ao1000);
});

test('every-long-average PB option defaults off, applies immediately and retains daily limits when disabled', async () => {
  await timedApp(Array.from({ length: 999 }, (_, i) => historySolve(999 - i, 10000 + i * 1000, 2)));
  jest.setSystemTime(new Date(2026, 10, 1, 12));
  await click('Options');
  const setting = container.querySelector<HTMLInputElement>('input[aria-describedby="long-pb-notifications-help"]')!;
  expect(setting.checked).toBe(false);
  await act(async () => setting.click());
  expect(localStorage.getItem('timer-show-every-long-pb')).toBe('true');
  await finishFirst();
  await act(async () => jest.advanceTimersByTime(501));
  await act(async () => resolveNext('F L2'));
  await act(async () => { move('F', 2000); move('L2', 2100); move('L2', 2200); move("F'", 2400); });
  await act(async () => jest.advanceTimersByTime(501));
  for (const name of ['Ao100', 'Ao1000']) expect(container.querySelectorAll(`[aria-label="View PB ${name}"]`)).toHaveLength(2);
  await act(async () => setting.click());
  expect(localStorage.getItem('timer-show-every-long-pb')).toBe('false');
  await act(async () => { move('B', 3000); move('R2', 3100); move('R2', 3200); move("B'", 3300); });
  await act(async () => jest.advanceTimersByTime(501));
  for (const name of ['Ao100', 'Ao1000']) expect(container.querySelectorAll(`[aria-label="View PB ${name}"]`)).toHaveLength(2);
  expect(container.querySelectorAll('[aria-label="View PB Single"]')).toHaveLength(3);
});

test('saved every-long-average PB preference restores and overrides an already-used daily ledger', async () => {
  localStorage.setItem('timer-show-every-long-pb', 'true');
  await timedApp(Array.from({ length: 999 }, (_, i) => historySolve(999 - i, 10000 + i * 1000, 2)));
  jest.setSystemTime(new Date(2026, 10, 1, 12));
  localStorage.setItem('timer-pb-daily-records', '{"date":"2026-11-01","records":["Ao100","Ao1000"]}');
  await click('Options');
  expect(container.querySelector<HTMLInputElement>('input[aria-describedby="long-pb-notifications-help"]')!.checked).toBe(true);
  await finishFirst();
  await act(async () => jest.advanceTimersByTime(501));
  for (const name of ['Ao100', 'Ao1000']) expect(container.querySelector(`[aria-label="View PB ${name}"]`)).not.toBeNull();
});

test('blocked storage keeps long-average PBs daily by default but still allows showing every PB', async () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked'); });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked'); });
  await timedApp(Array.from({ length: 999 }, (_, i) => historySolve(999 - i, 10000 + i * 1000, 2)));
  await click('Options');
  const setting = container.querySelector<HTMLInputElement>('input[aria-describedby="long-pb-notifications-help"]')!;
  expect(setting.checked).toBe(false);
  await finishFirst();
  await act(async () => jest.advanceTimersByTime(501));
  await act(async () => setting.click());
  expect(setting.checked).toBe(true);
  expect(container.querySelector('.options-dialog')?.textContent).toContain('PB notification preference changed');
  await act(async () => resolveNext('F L2'));
  await act(async () => { move('F', 2000); move('L2', 2100); move('L2', 2200); move("F'", 2400); });
  await act(async () => jest.advanceTimersByTime(501));
  for (const name of ['Ao100', 'Ao1000']) expect(container.querySelectorAll(`[aria-label="View PB ${name}"]`)).toHaveLength(2);
});

test.each([1000, 3000])('penalty updates are included before comparing a solve against a %s ms PB', async previous => {
  await timedApp([historySolve(1, previous, 2)]);
  await finishFirst();
  await act(async () => move('F', 1000));
  await act(async () => jest.advanceTimersByTime(501));
  const celebration = container.querySelector('[aria-label="Personal best"]');
  if (previous === 1000) expect(celebration).toBeNull();
  else expect(celebration?.textContent).toContain('Single: 2.60s');
});

test('a premature completion invalidated within the penalty window does not celebrate', async () => {
  await timedApp();
  await click('Connect cube');
  await act(async () => { move('R', 100, 1); move('U2', 200, 2); move('U2', 300, 3); move("R'", 900, 4); });
  jest.mocked(cube.solution).mockResolvedValueOnce(["F'"]);
  await act(async () => move('F', 1000, 6));
  await act(async () => resolveNext('F L2'));
  await act(async () => jest.advanceTimersByTime(501));
  expect(container.querySelector('[aria-label="Personal best"]')).toBeNull();
  expect(save.mock.calls.at(-1)![0][0].status).toBe('incomplete');
});

test('loading existing records does not replay PB celebrations', async () => {
  await timedApp([historySolve(1, 1000, 2)]);
  await act(async () => jest.advanceTimersByTime(5000));
  expect(container.querySelector('[aria-label="Personal best"]')).toBeNull();
});

test('a slower newest Ao12 does not notify for a historical floating-point PB', async () => {
  const durations = [11061.2, 11049.64, 12629.46, 12904.71, 13730.08, 11337.38, 12487.66, 12645.04, 12788.3, 13350.35, 11119.56, 11000];
  await timedApp(durations.map((duration, i) => historySolve(12 - i, duration, 2)));
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); move('U2', 300); move("R'", 15300); });
  await act(async () => jest.advanceTimersByTime(501));
  expect(container.querySelector('[aria-label="Personal best"]')).toBeNull();
  expect(container.querySelector('[aria-label="View current Ao12"]')?.textContent).toBe('12.41');
  expect(container.querySelector('[aria-label="View best Ao12"]')?.textContent).toBe('12.14');
});

test('average PB notifications retain their original window after later solves and session changes', async () => {
  await timedApp([12000, 14000, 16000, 18000, 20000].map((duration, i) => historySolve(5 - i, duration, 2)));
  await finishFirst();
  await act(async () => jest.advanceTimersByTime(501));
  await act(async () => resolveNext('F L2'));
  await act(async () => { move('F', 2000); move('L2', 2100); move('L2', 2200); move("F'", 2400); });
  await act(async () => jest.advanceTimersByTime(501));
  await click('Options');
  const session = container.querySelector<HTMLInputElement>('input[maxlength="100"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(session, 'Other');
    session.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLDialogElement>('.options-dialog')!.close());
  expect(container.querySelector('[aria-label="View current Ao5"]')).toBeNull();
  await click('View PB Ao5');
  expect(container.querySelector('#average-title')?.textContent).toBe('Ao5: 14.00s');
  const rows = container.querySelectorAll('[aria-label="Average solves"] tbody tr');
  expect(Array.from(rows, row => row.children[0].textContent)).toEqual(['2', '3', '4', '5', '6']);
  expect(Array.from(rows, row => row.children[1].textContent)).toEqual(['(18.00s)', '16.00s', '14.00s', '12.00s', '(0.60s)']);
});

test.each([5, 12, 100, 1000])('current and best Ao%s open their exact windows with the correct number of exclusions', async count => {
  const solves = Array.from({ length: count + 2 }, (_, i) => historySolve(i + 1, 10000 + i * 100, 2));
  await showHistory([...solves, historySolve(count + 3, 1, 2, 'Other'), historySolve(count + 4, 1, 2, 'Default', 'incomplete')]);
  for (const kind of ['current', 'best']) {
    await click(`View ${kind} Ao${count}`);
    const rows = container.querySelectorAll('[aria-label="Average solves"] tbody tr');
    expect(rows).toHaveLength(count);
    const trim = Math.ceil(count / 20);
    expect(container.querySelectorAll('.average-trimmed-best')).toHaveLength(trim);
    expect(container.querySelectorAll('.average-trimmed-worst')).toHaveLength(trim);
    const start = kind === 'current' ? 2 : 0;
    expect(Array.from(rows, row => row.children[0].textContent)).toEqual(solves.slice(start, start + count).map(solve => solve.id));
    expect(Array.from(rows, row => row.children[1].textContent)).toEqual(solves.slice(start, start + count).map((solve, index) => {
      const time = `${(solve.duration / 1000).toFixed(2)}s`;
      return index < trim || index >= count - trim ? `(${time})` : time;
    }));
    await click(`View average solve ${start + 1}`);
    expect(container.querySelector('[aria-label="Solve replay"]')?.getAttribute('data-solve-id')).toBe(solves[start].id);
    await click('Close replay');
    await click('Close average');
    expect(container.querySelector('.average-dialog')).toBeNull();
  }
}, 15000);

test('average solve numbers match session history across DNFs, active solves and display sorting', async () => {
  const solves = [
    historySolve(1, 2000, 2, 'Default', 'incomplete'), historySolve(2, 20000, 2),
    historySolve(3, 3000, 2, 'Default', 'incomplete'),
    ...Array.from({ length: 5 }, (_, i) => historySolve(i + 4, 10000 + i * 1000, 2)),
    { ...historySolve(9, 4000, 2, 'Default', 'incomplete'), createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 6, 500)).toISOString() },
    historySolve(10, 1, 2, 'Default', 'active'), historySolve(11, 1, 2, 'Other'),
  ];
  await showHistory(solves);
  await click('Time');
  const history = container.querySelectorAll('[aria-label="Solve history"] tbody tr');
  const expected = Array.from(history).filter(row => /^(10|11|12|13|14)\.00s$/.test(row.children[1].textContent!))
    .map(row => row.children[0].textContent);
  expect(expected).toEqual(['4', '5', '6', '8', '9']);
  await click('View current Ao5');
  const rows = container.querySelectorAll('[aria-label="Average solves"] tbody tr');
  expect(Array.from(rows, row => row.children[0].textContent)).toEqual(expected);
  await click('View average solve 8');
  expect(container.querySelector('[aria-label="Solve replay"]')?.getAttribute('data-solve-id')).toBe('7');
});

test.each(['accepted', 'dismissed'] as const)('Options prompts installation once when Chrome offers it (%s)', async outcome => {
  await click('Options');
  const button = container.querySelector<HTMLButtonElement>('button[aria-describedby="install-help"]')!;
  expect(button.closest('dialog')).not.toBeNull();
  expect(button.disabled).toBe(true);
  const prompt = jest.fn<InstallOffer['prompt']>().mockResolvedValue({ outcome });
  const offer = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt });
  await act(async () => window.dispatchEvent(offer));
  expect(offer.defaultPrevented).toBe(true);
  expect(button.disabled).toBe(false);
  expect(prompt).not.toHaveBeenCalled();
  await click('Install app');
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(prompt).toHaveBeenCalledTimes(1);
  if (outcome === 'accepted') {
    await act(async () => window.dispatchEvent(new Event('appinstalled')));
    expect(container.querySelector('button[aria-describedby="install-help"]')).toBeNull();
  } else {
    await act(async () => window.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt })));
    expect(button.disabled).toBe(false);
  }
});

type InstallOffer = { prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }> };

test('an installation failure stays inside Options and a fresh offer permits retry', async () => {
  await click('Options');
  const prompt = jest.fn<InstallOffer['prompt']>().mockRejectedValue(new Error('Prompt unavailable'));
  await act(async () => window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), { prompt })));
  await click('Install app');
  expect(container.querySelector('dialog [role="alert"]')?.textContent).toContain('Installation could not start');
  expect(container.querySelector<HTMLButtonElement>('button[aria-describedby="install-help"]')!.disabled).toBe(true);
  prompt.mockResolvedValue({ outcome: 'dismissed' });
  await act(async () => window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), { prompt })));
  expect(container.querySelector('dialog [role="alert"]')).toBeNull();
  await click('Install app');
  expect(prompt).toHaveBeenCalledTimes(2);
});

test('standalone launches omit installation controls and unmount removes install listeners', async () => {
  const removeListener = jest.spyOn(window, 'removeEventListener');
  jest.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  await showHistory([]);
  expect(removeListener).toHaveBeenCalledWith('beforeinstallprompt', expect.any(Function));
  expect(removeListener).toHaveBeenCalledWith('appinstalled', expect.any(Function));
  await click('Options');
  const prompt = jest.fn<InstallOffer['prompt']>().mockResolvedValue({ outcome: 'accepted' });
  const offer = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt });
  await act(async () => window.dispatchEvent(offer));
  expect(offer.defaultPrevented).toBe(false);
  expect(container.querySelector('button[aria-describedby="install-help"]')).toBeNull();
});

test('history numbers every non-active attempt chronologically within its session', async () => {
  await showHistory([
    historySolve(3, 3000, 3), historySolve(1, 1000, 1), historySolve(4, 4000, 4, 'Other'),
    historySolve(2, 2000, 2, 'Default', 'incomplete'), historySolve(5, 0, 0, 'Default', 'active'),
  ]);
  expect(historyNumbers()).toEqual([3, 2, 1]);
  expect(container.querySelector('th[aria-sort="descending"]')?.textContent).toBe('Solve number');
  await click('Solve number');
  expect(historyNumbers()).toEqual([1, 2, 3]);
  await click('Solve number');
  expect(historyNumbers()).toEqual([3, 2, 1]);
});

test('history headers sort numeric values in both directions without renumbering solves', async () => {
  await showHistory([
    historySolve(1, 10000, 30), historySolve(2, 2000, 10), historySolve(3, 4000, 4), historySolve(4, 0, 0, 'Default', 'incomplete'),
  ]);
  for (const [column, ascending, descending] of [
    ['Time', [4, 2, 3, 1], [1, 3, 2, 4]],
    ['Turns', [4, 3, 2, 1], [1, 2, 3, 4]],
    ['TPS', [3, 1, 2, 4], [2, 1, 3, 4]],
  ] as const) {
    await click(column);
    expect(historyNumbers()).toEqual(ascending);
    expect(container.querySelector('th[aria-sort="ascending"]')?.textContent).toBe(column);
    await click(column);
    expect(historyNumbers()).toEqual(descending);
    expect(container.querySelector('th[aria-sort="descending"]')?.textContent).toBe(column);
  }
  const rows = container.querySelectorAll('[aria-label="Solve history"] tbody tr');
  expect(Array.from(rows).map(row => row.children[1].textContent?.trim())).toEqual(['2.00s', '10.00s', '4.00s', '0.00s DNF']);
  expect(rows[3].children[3].textContent).toBe('--');
});

test('history sorts the full session before applying the display limit', async () => {
  await showHistory(Array.from({ length: 105 }, (_, index) => historySolve(index + 1, (index + 1) * 1000, 1)));
  expect(historyNumbers()).toEqual(Array.from({ length: 100 }, (_, index) => 105 - index));
  await click('Time');
  expect(historyNumbers()).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
});

test('cube card omits redundant instructions while preserving highlighting and correction messages', async () => {
  expect(container.querySelector('h1')?.textContent).toBe('CuberPlus - Timer');
  expect(container.textContent).not.toContain('Smart cube timing.');
  await click('Connect cube');
  const panel = container.querySelector('.timer-panel')!;
  const checkText = () => {
    expect(panel.textContent).not.toMatch(/Follow the highlighted|Wrong turn\.|Turn .+ once more|Scramble complete\.|Next:|Last solve|Use the cube's calibrated face/);
    expect(panel.querySelector('.next-move')).toBeNull();
    expect(panel.querySelector('.badge')).toBeNull();
  };
  checkText();
  expect(container.querySelector('.scramble .current')?.textContent).toBe('R');
  await act(async () => move('F', 100));
  checkText();
  expect(container.querySelector('[aria-label="Correction moves"]')?.textContent).toBe("F'");
  await act(async () => move("F'", 200));
  checkText();
  await act(async () => { move('R', 300); move('U2', 400); move('U2', 500); move("R'", 1100); });
  checkText();
  expect(panel.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.60');
  await act(async () => resolveNext('F L2'));
  checkText();
  expect(container.querySelector('.scramble .current')?.textContent).toBe('F');
});

test('scramble leads the timer card and cube-state controls follow the timing splits', async () => {
  const panel = container.querySelector('.timer-panel')!;
  expect(container.querySelector('main > section')).toBe(panel);
  expect(panel.firstElementChild).toBe(container.querySelector('[aria-label="Scramble"]'));
  await finishFirst();
  const timeline = panel.querySelector('[aria-label="Solve timeline"]')!;
  expect(timeline).not.toBeNull();
  for (const label of ['Read cube state', 'Cube is physically solved - calibrate']) {
    const button = Array.from(panel.querySelectorAll('button')).find(button => button.textContent === label)!;
    expect(button).toBeDefined();
    expect(timeline.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.closest('.row')).toBeNull();
  }
});

test('double-turn and ready instructions stay hidden without changing first-turn timing', async () => {
  generate.mockReset().mockResolvedValue('R2');
  await click('Connect cube');
  const panel = container.querySelector('.timer-panel')!;
  await act(async () => move('R', 100));
  expect(panel.textContent).not.toContain('Turn R once more to complete R2');
  expect(container.querySelector('.scramble .current')?.textContent).toBe('R2');
  await act(async () => move('R', 200));
  expect(panel.textContent).not.toContain('Scramble complete.');
  expect(panel.classList.contains('ready')).toBe(true);
  expect(panel.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.00');
  await act(async () => { move('R', 300); move('R', 500); });
  expect(panel.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.20');
  expect(save.mock.calls.flatMap(([solves]) => solves).at(-1)?.status).toBe('complete');
});

test('scramble keeps completed moves, replaces unfinished moves with red corrections, and marks partial turns', async () => {
  await click('Connect cube');
  const scramble = container.querySelector('[aria-label="Scramble"]')!;
  expect(scramble.closest('section')!.querySelector('h2')).toBeNull();
  await act(async () => move('R', 100));
  expect(scramble.querySelector('.done')?.textContent).toBe('R');
  await act(async () => { move('F', 200); move('L', 300); });
  expect(scramble.querySelector('.done')?.textContent).toBe('R');
  expect(Array.from(scramble.querySelectorAll('.correction')).map(move => move.textContent)).toEqual(["L'", "F'"]);
  expect(scramble.querySelector('.current')?.classList.contains('correction')).toBe(true);
  expect(scramble.textContent).not.toContain('U2');
  await act(async () => move("L'", 400));
  expect(scramble.querySelector('[aria-label="Correction moves"]')?.textContent).toBe("F'");
  await act(async () => move("F'", 500));
  expect(scramble.querySelector('.correction')).toBeNull();
  expect(scramble.querySelector('.current')?.textContent).toBe('U2');
  await act(async () => move('U', 600));
  expect(scramble.querySelector('.current.partial')?.textContent).toBe('U2');
  await act(async () => move("U'", 650));
  expect(scramble.querySelector('.partial')).toBeNull();
  await act(async () => move("U'", 700));
  expect(scramble.querySelector('.current.partial')?.textContent).toBe('U2');
  await act(async () => move("U'", 800));
  expect(scramble.querySelector('.current')).toBeNull();
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.00');
});

test('scramble highlights the first pending move while a commuting later move turns green', async () => {
  generate.mockReset().mockResolvedValue('R L U');
  await click('Connect cube');
  const scramble = container.querySelector('[aria-label="Scramble"]')!;
  await act(async () => move('L', 100));
  expect(scramble.querySelector('.current')!.textContent).toBe('R');
  expect(Array.from(scramble.querySelectorAll('.done')).map(move => move.textContent)).toEqual(['L']);
  expect(scramble.querySelector('.correction')).toBeNull();
  await act(async () => move('F', 200));
  expect(Array.from(scramble.querySelectorAll('.done')).map(move => move.textContent)).toEqual(['L']);
  expect(scramble.querySelector('.correction')!.textContent).toBe("F'");
  await act(async () => move("F'", 300));
  expect(scramble.querySelector('.current')!.textContent).toBe('R');
  expect(Array.from(scramble.querySelectorAll('.done')).map(move => move.textContent)).toEqual(['L']);
  await act(async () => move('R', 400));
  expect(scramble.querySelector('.current')!.textContent).toBe('U');
  expect(Array.from(scramble.querySelectorAll('.done')).map(move => move.textContent)).toEqual(['R', 'L']);
  await act(async () => move('U', 500));
  expect(scramble.querySelector('.current')).toBeNull();
  expect(Array.from(scramble.querySelectorAll('.done')).map(move => move.textContent)).toEqual(['R', 'L', 'U']);
  expect(container.querySelector('.timer-panel')!.classList.contains('ready')).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

test('displayed scrambles combine repeated faces across commuting moves', async () => {
  generate.mockReset().mockResolvedValue('R L R U U2');
  await click('Connect cube');
  const scramble = container.querySelector('[aria-label="Scramble"]')!;
  expect(Array.from(scramble.querySelectorAll('.move')).map(move => move.textContent)).toEqual(['R2', 'L', "U'"]);
  await act(async () => { move('L', 100); move('R', 200); });
  expect(scramble.querySelector('.current.partial')!.textContent).toBe('R2');
  expect(scramble.querySelector('.done')!.textContent).toBe('L');
  await act(async () => { move('R', 300); move("U'", 400); });
  expect(container.querySelector('.timer-panel')!.classList.contains('ready')).toBe(true);
});

test('the scramble refresh icon replaces a partially applied scramble with valid setup and does not interrupt a solve', async () => {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="New scramble"]')!;
  expect(button.closest('[aria-label="Scramble"]')).not.toBeNull();
  expect(button.querySelector('svg')).not.toBeNull();
  expect(button.disabled).toBe(true);
  await click('Connect cube');
  expect(button.disabled).toBe(false);
  await act(async () => move('R', 100));
  const initial = cube.facelets(cube.solved().applyMove('R'));
  const solution = jest.spyOn(cube, 'solution').mockResolvedValueOnce(["R'"]);
  await click('New scramble');
  expect(button.disabled).toBe(true);
  expect(generate).toHaveBeenCalledTimes(2);
  await act(async () => button.click());
  expect(generate).toHaveBeenCalledTimes(2);
  await act(async () => resolveNext('F L2'));
  expect(solution).toHaveBeenCalledWith(initial);
  expect(button.disabled).toBe(false);
  expect(container.querySelector('[aria-label="Live 3x3 cube state"]')!.getAttribute('data-facelets')).toBe(initial);
  expect(Array.from(container.querySelectorAll('.scramble .move')).map(move => move.textContent)).toEqual(['F', 'L2']);
  expect(container.querySelector('.scramble .done')).toBeNull();
  expect(container.querySelector('.timer-panel > p .current')!.textContent).toBe("R'");
  expect(save).not.toHaveBeenCalled();
  await act(async () => { move("R'", 200); move('F', 300); move('L2', 400); });
  expect(button.disabled).toBe(false);
  await act(async () => move('L2', 500));
  expect(button.disabled).toBe(true);
  expect(button.getAttribute('aria-hidden')).toBe('true');
  await act(async () => button.click());
  expect(generate).toHaveBeenCalledTimes(2);
  await act(async () => move("F'", 900));
  const solve = save.mock.calls.flatMap(([solves]) => solves).at(-1)!;
  expect(solve.status).toBe('complete');
  expect(solve.scramble).toBe('F L2');
  expect(solve.inspection).toBe(100);
  expect(solve.duration).toBe(400);
});

test('refreshing a ready scramble resets inspection until the new scramble is complete', async () => {
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); });
  jest.spyOn(cube, 'solution').mockResolvedValueOnce(['U2', "R'"]);
  await click('New scramble');
  await act(async () => resolveNext('F L2'));
  await act(async () => { move('U2', 300); move("R'", 400); move('F', 500); move('L2', 600); move('L2', 1000); move("F'", 1200); });
  const solve = save.mock.calls.flatMap(([solves]) => solves).at(-1)!;
  expect(solve.scramble).toBe('F L2');
  expect(solve.inspection).toBe(400);
  expect(solve.duration).toBe(200);
});

test('a failed manual scramble refresh shows the error and disables refresh until resynchronization', async () => {
  await click('Connect cube');
  generate.mockReset().mockRejectedValueOnce(new Error('Scramble generation failed'));
  await click('New scramble');
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('Scramble generation failed');
  expect(container.querySelector<HTMLButtonElement>('[aria-label="New scramble"]')!.disabled).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

test.each(['D', "D'"])('a single %s partially highlights D2 in U2 D2 without moving the U2 box', async quarter => {
  generate.mockReset().mockResolvedValue('U2 D2');
  await click('Connect cube');
  const scramble = container.querySelector('[aria-label="Scramble"]')!;
  await act(async () => move(quarter, 100));
  expect(scramble.querySelector('.current')!.textContent).toBe('U2');
  expect(scramble.querySelector('.current.partial')).toBeNull();
  const second = scramble.querySelector('.partial')!;
  expect(second.textContent).toBe('D2');
  expect(second.classList.contains('current')).toBe(false);
  expect(second.getAttribute('title')).toBe('Partially complete');
  expect(scramble.querySelector('.done')).toBeNull();
  expect(scramble.querySelector('.correction')).toBeNull();
  await act(async () => move('U', 200));
  expect(Array.from(scramble.querySelectorAll('.partial')).map(move => move.textContent)).toEqual(['U2', 'D2']);
  expect(scramble.querySelector('.current.partial')!.textContent).toBe('U2');
  await act(async () => move("U'", 250));
  expect(scramble.querySelector('.current.partial')).toBeNull();
  expect(scramble.querySelector('.partial')!.textContent).toBe('D2');
  await act(async () => move(inverse(quarter), 300));
  expect(scramble.querySelector('.partial')).toBeNull();
  expect(scramble.querySelector('.done')).toBeNull();
  expect(scramble.querySelector('.current')!.textContent).toBe('U2');
  await act(async () => { move(quarter, 350); move(quarter, 450); });
  expect(scramble.querySelector('.partial')).toBeNull();
  expect(scramble.querySelector('.done')!.textContent).toBe('D2');
  expect(scramble.querySelector('.done')!.getAttribute('title')).toBeNull();
  expect(scramble.querySelector('.current')!.textContent).toBe('U2');
  await act(async () => move('U2', 500));
  expect(scramble.querySelector('.current')).toBeNull();
  expect(scramble.querySelector('.partial')).toBeNull();
  expect(Array.from(scramble.querySelectorAll('.done')).map(move => move.textContent)).toEqual(['U2', 'D2']);
  expect(container.querySelector('.timer-panel')!.classList.contains('ready')).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

test('partial highlights apply only to the current commuting block and recover after a wrong turn', async () => {
  generate.mockReset().mockResolvedValue('U2 D2 F D2');
  await click('Connect cube');
  const scramble = container.querySelector('[aria-label="Scramble"]')!;
  await act(async () => move('D', 100));
  const moves = scramble.querySelectorAll('.move');
  expect(moves[1].classList.contains('partial')).toBe(true);
  expect(moves[3].classList.contains('partial')).toBe(false);
  expect(moves[3].getAttribute('title')).toBeNull();
  await act(async () => move('R', 200));
  expect(scramble.querySelector('.partial')).toBeNull();
  expect(scramble.querySelector('.current.correction')!.textContent).toBe("R'");
  await act(async () => move("R'", 300));
  expect(scramble.querySelector('.current')!.textContent).toBe('U2');
  expect(scramble.querySelectorAll('.partial')).toHaveLength(1);
  expect(scramble.querySelector('.partial')!.textContent).toBe('D2');
  expect(scramble.querySelector('.correction')).toBeNull();
});

test('red corrections use shortened undo moves and disappear once the mistake is corrected', async () => {
  await click('Connect cube');
  await act(async () => {
    move('F', 100);
    for (let i = 0; i < 10; i++) move('U', 200 + i * 100);
  });
  const scramble = container.querySelector('[aria-label="Scramble"]')!;
  expect(Array.from(scramble.querySelectorAll('.correction')).map(move => move.textContent)).toEqual(['U2', "F'"]);
  await act(async () => move('U2', 1500));
  expect(scramble.querySelector('.correction')?.textContent).toBe("F'");
  await act(async () => move("F'", 1600));
  expect(scramble.querySelector('.correction')).toBeNull();
  expect(scramble.querySelector('.current')?.textContent).toBe('R');
});

test('returning to solved removes corrections and displays the full original scramble again', async () => {
  await click('Connect cube');
  const scramble = container.querySelector('[aria-label="Scramble"]')!;
  await act(async () => { move('R', 100); move('F', 200); });
  expect(scramble.querySelector('.correction')).not.toBeNull();
  await act(async () => { move("F'", 300); move("R'", 400); });
  expect(scramble.querySelector('.correction')).toBeNull();
  expect(scramble.querySelector('.done')).toBeNull();
  expect(Array.from(scramble.querySelectorAll('.move')).map(move => move.textContent)).toEqual(['R', 'U2']);
  expect(scramble.querySelector('.current')?.textContent).toBe('R');
  expect(generate).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.00');
});

test('Bluetooth setup and its help link live in Options, and submitting closes the dialog to connect', async () => {
  const dialog = container.querySelector('dialog')!;
  const mac = container.querySelector('input[placeholder="AA:BB:CC:DD:EE:FF"]')!;
  expect(mac.closest('dialog')).toBe(dialog);
  expect(container.querySelector('a[href="help/mac-address.html"]')?.closest('dialog')).toBe(dialog);
  await click('Options');
  await act(async () => mac.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(dialog.open).toBe(false);
  expect(container.querySelector('input[placeholder="AA:BB:CC:DD:EE:FF"]')).toBeNull();
});

test('normal saving and saved messages remain hidden during a pending write and after completion', async () => {
  let finishSave: () => void;
  save.mockImplementationOnce(() => new Promise<void>(resolve => { finishSave = resolve; }));
  await finishFirst();
  expect(container.textContent).not.toMatch(/Saving locally|Saved locally/);
  await act(async () => finishSave());
  expect(container.textContent).not.toMatch(/Saving locally|Saved locally/);
});

test('simulation remains available for testing but hidden, and battery follows the header controls', async () => {
  const simulator = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Try simulated cube')!;
  expect(simulator.hidden).toBe(true);
  await click('Try simulated cube');
  expect(container.querySelector('.demo')).not.toBeNull();
  await click('Disconnect');
  await click('Connect cube');
  await act(async () => emit({ type: 'BATTERY', timestamp: 0, batteryLevel: 88 }));
  const battery = container.querySelector('header .badge')!;
  expect(battery.textContent).toBe('88% battery');
  expect(battery.parentElement!.lastElementChild).toBe(battery);
});

test('shows CFOP milestones during an active solve without exporting', async () => {
  const pll = "R U R' U' R' F R2 U' R' U' R U R' F'", oll = "R U R' U R U2 R'";
  const scramble = `${pll} ${oll} R U R' F U F' L U L' B U B' D`;
  generate.mockReset().mockResolvedValueOnce(scramble).mockResolvedValue('B R2');
  await click('Connect cube');
  await act(async () => scramble.split(' ').forEach((turn, i) => move(turn, i * 100)));
  expect(container.querySelector('[aria-label="CFOP steps"]')).toBeNull();
  await act(async () => move("D'", 4000));
  expect(container.textContent).not.toContain('reported moves recorded');
  expect(container.querySelector('.trail-duration[data-step="0"][data-status="done"]')).not.toBeNull();
  expect(container.querySelector('.trail-duration[data-step="1"][data-status="pending"]')).not.toBeNull();
  await act(async () => { move('B', 4100); move("U'", 4200); move("B'", 4300); });
  expect(container.querySelector('.trail-duration[data-step="1"][data-status="done"]')).not.toBeNull();
  expect(container.querySelector('.trail-duration[data-step="2"][data-status="pending"]')).not.toBeNull();
  expect(container.querySelector('.trail-duration[data-step="6"][data-status="unreached"]')).not.toBeNull();
  expect(save.mock.calls.flatMap(([solves]) => solves).every(solve => solve.status === 'active')).toBe(true);
});

test('keeps inspection recorded but hidden from the main timer', async () => {
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); });
  expect(container.querySelector('[aria-label="Inspection time"]')).toBeNull();
  await act(async () => {
    jest.mocked(performance.now).mockReturnValue(1250);
    emit({ type: 'BATTERY', timestamp: 1250, batteryLevel: 80 });
  });
  expect(container.querySelector('[aria-label="Inspection time"]')).toBeNull();
  await act(async () => { move('U2', 1500); move("R'", 1900); });
  expect(container.querySelector('[aria-label="Inspection time"]')).toBeNull();
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.40');
  expect(save.mock.calls.flatMap(([solves]) => solves).at(-1)?.inspection).toBe(1300);
});

test('hides scramble moves only during solving, without removing their layout container', async () => {
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); });
  const scramble = container.querySelector('.timer-panel > .scramble')!;
  const content = scramble.querySelector('.scramble-content')!;
  expect(content.getAttribute('aria-hidden')).toBe('false');
  await act(async () => move('U', 300));
  expect(scramble.classList.contains('scramble-solving')).toBe(true);
  expect(scramble.querySelector('.scramble-content')).toBe(content);
  expect(content.getAttribute('aria-hidden')).toBe('true');
  expect(content.querySelectorAll('.move')).toHaveLength(2);
  expect(scramble.querySelector('[role="status"]')!.textContent).toBe('Scrambles hidden while solving');
  expect(scramble.querySelector('button')!.textContent).toBe('Abort solve');
  expect(container.querySelector('.timer-details button')).toBeNull();
  await act(async () => { move('U', 400); move("R'", 500); });
  expect(content.getAttribute('aria-hidden')).toBe('false');
  expect(scramble.classList.contains('scramble-solving')).toBe(false);
  expect(scramble.querySelector('.scramble-placeholder')).toBeNull();
});

test('the abort button beside the hidden-scramble message still saves an incomplete attempt', async () => {
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); move('U', 300); });
  expect(container.querySelector('.scramble-placeholder button')).not.toBeNull();
  await click('Abort solve');
  expect(container.querySelector('.scramble-placeholder')).toBeNull();
  const solve = save.mock.calls.flatMap(([solves]) => solves).at(-1)!;
  expect(solve.status).toBe('incomplete');
  expect(solve.reason).toBe('Solve aborted by user.');
  expect(solve.moves).toHaveLength(1);
});

test('hiding distracting visuals defaults off, persists, and does not change solve timing or recording', async () => {
  await click('Options');
  const setting = container.querySelector<HTMLInputElement>('input[type="checkbox"][aria-describedby="hide-visuals-help"]')!;
  expect(setting.checked).toBe(false);
  await act(async () => setting.click());
  expect(JSON.parse(localStorage.getItem('timer-hide-distracting-visuals')!)).toEqual({ timer: true, cube: true, progressBar: true });
  await click('Close options');
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); });
  expect(container.querySelector('[aria-label="Solve time"]')).not.toBeNull();
  expect(container.querySelector('.timer-panel [role="img"]')).not.toBeNull();
  expect(container.querySelector('[role="status"][aria-label="Solving"]')).toBeNull();
  await act(async () => move('U2', 300));
  const indicator = container.querySelector('[role="status"][aria-label="Solving"]')!;
  expect(indicator.firstElementChild!.textContent).toBe('Solving');
  expect(indicator.querySelector('.solving-dots')!.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('[aria-label="Solve time"]')).toBeNull();
  expect(container.querySelector('.timer-panel [role="img"]')).toBeNull();
  expect(container.querySelector('[aria-label="Solve timeline"]')).toBeNull();
  expect(container.querySelector('.scramble-placeholder button')).not.toBeNull();
  await act(async () => move("R'", 900));
  expect(container.querySelector('[aria-label="Solving"]')).toBeNull();
  expect(container.querySelector('[aria-label="Solve time"]')!.textContent).toBe('0.60');
  expect(container.querySelector('.timer-panel [role="img"]')!.getAttribute('data-facelets')).toBe(SOLVED);
  expect(container.querySelector('[aria-label="Solve timeline"]')).not.toBeNull();
  const solve = save.mock.calls.flatMap(([solves]) => solves).at(-1)!;
  expect(solve.status).toBe('complete');
  expect(solve.duration).toBe(600);
  expect(solve.inspection).toBe(100);
  expect(solve.moves.map(move => move.move)).toEqual(['U2', "R'"]);
  await showHistory([]);
  const restored = container.querySelector<HTMLInputElement>('input[type="checkbox"][aria-describedby="hide-visuals-help"]')!;
  expect(restored.checked).toBe(true);
  await act(async () => restored.click());
  expect(JSON.parse(localStorage.getItem('timer-hide-distracting-visuals')!)).toEqual({ timer: false, cube: false, progressBar: false });
  await showHistory([]);
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"][aria-describedby="hide-visuals-help"]')!.checked).toBe(false);
});

test.each(['Timer', 'Cube', 'Progress bar'])('the %s submenu toggle hides only that component and remembers a mixed selection', async name => {
  await click('Options');
  const submenu = container.querySelector('details')!;
  expect(submenu.querySelector('summary')!.textContent).toBe('Hide distracting visuals');
  const setting = Array.from(submenu.querySelectorAll('label')).find(label => label.textContent === name)!.querySelector<HTMLInputElement>('input')!;
  const all = submenu.querySelector<HTMLInputElement>('input[aria-describedby="hide-visuals-help"]')!;
  await act(async () => setting.click());
  expect(all.checked).toBe(false);
  expect(all.indeterminate).toBe(true);
  await showHistory([]);
  const restored = Array.from(container.querySelectorAll('details label')).find(label => label.textContent === name)!.querySelector<HTMLInputElement>('input')!;
  expect(restored.checked).toBe(true);
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); });
  expect(container.querySelector('[aria-label="Solve time"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Live 3x3 cube state"]')).not.toBeNull();
  await act(async () => move('U', 300));
  expect(!!container.querySelector('[aria-label="Solve time"]')).toBe(name !== 'Timer');
  expect(!!container.querySelector('[aria-label="Solving"]')).toBe(name === 'Timer');
  expect(!!container.querySelector('[aria-label="Live 3x3 cube state"]')).toBe(name !== 'Cube');
  expect(!!container.querySelector('[aria-label="Solve timeline"]')).toBe(name !== 'Progress bar');
  await act(async () => restored.click());
  expect(container.querySelector('[aria-label="Solve time"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Live 3x3 cube state"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Solve timeline"]')).not.toBeNull();
  const master = container.querySelector<HTMLInputElement>('input[aria-describedby="hide-visuals-help"]')!;
  expect(master.checked).toBe(false);
  expect(master.indeterminate).toBe(false);
});

test.each(['true', 'false', '{"timer":true,"cube":"true","progressBar":false}', '{'])('loads legacy or partial visual preferences safely: %s', async stored => {
  localStorage.setItem('timer-hide-distracting-visuals', stored);
  await showHistory([]);
  const fields = Array.from(container.querySelectorAll<HTMLInputElement>('details input'));
  expect(fields.map(field => field.checked)).toEqual(stored === 'true' ? [true, true, true, true] : stored.startsWith('{"') ? [false, true, false, false] : [false, false, false, false]);
  expect(fields[0].indeterminate).toBe(stored.startsWith('{"'));
});

test('hide all can be toggled during a solve, including a mixed selection, and abort restores the visuals', async () => {
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); move('U', 300); });
  expect(container.querySelector('[aria-label="Solve time"]')).not.toBeNull();
  expect(container.querySelector('.timer-panel [role="img"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Solve timeline"]')).not.toBeNull();
  await click('Options');
  const setting = container.querySelector<HTMLInputElement>('input[type="checkbox"][aria-describedby="hide-visuals-help"]')!;
  await act(async () => setting.click());
  expect(container.querySelector('[aria-label="Solving"]')).not.toBeNull();
  const cubeSetting = Array.from(container.querySelectorAll('details label')).find(label => label.textContent === 'Cube')!.querySelector<HTMLInputElement>('input')!;
  await act(async () => cubeSetting.click());
  expect(setting.indeterminate).toBe(true);
  expect(container.querySelector('[aria-label="Solve time"]')).toBeNull();
  expect(container.querySelector('.timer-panel [role="img"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Solve timeline"]')).toBeNull();
  await act(async () => setting.click());
  expect(setting.checked).toBe(true);
  expect(setting.indeterminate).toBe(false);
  expect(container.querySelector('.timer-panel [role="img"]')).toBeNull();
  await act(async () => setting.click());
  expect(container.querySelector('[aria-label="Solving"]')).toBeNull();
  expect(container.querySelector('[aria-label="Solve time"]')).not.toBeNull();
  expect(container.querySelector('.timer-panel [role="img"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Solve timeline"]')).not.toBeNull();
  await act(async () => setting.click());
  await click('Close options');
  await click('Abort solve');
  expect(container.querySelector('[aria-label="Solving"]')).toBeNull();
  expect(container.querySelector('[aria-label="Solve time"]')).not.toBeNull();
  expect(container.querySelector('.timer-panel [role="img"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Solve timeline"]')).not.toBeNull();
  expect(save.mock.calls.flatMap(([solves]) => solves).at(-1)?.status).toBe('incomplete');
});

test('blocked preference storage defaults visual hiding off but still permits changing it', async () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  await showHistory([]);
  await click('Options');
  const setting = container.querySelector<HTMLInputElement>('input[type="checkbox"][aria-describedby="hide-visuals-help"]')!;
  expect(setting.checked).toBe(false);
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  await act(async () => setting.click());
  expect(setting.checked).toBe(true);
  expect(container.querySelector('dialog [role="alert"]')!.textContent).toContain('could not save the preference');
  await click('Close options');
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); move('U', 300); });
  expect(container.querySelector('[aria-label="Solving"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Solve time"]')).toBeNull();
});

test('options change timer and CFOP precision immediately and remember the preference', async () => {
  await finishFirst();
  const dialog = container.querySelector('dialog')!;
  expect(dialog.open).toBe(false);
  expect(container.querySelector('header select')).toBeNull();
  expect(container.textContent).not.toContain('Saved locally');
  expect(container.querySelectorAll('input[maxlength="100"]')).toHaveLength(1);
  expect(dialog.querySelector<HTMLInputElement>('input')?.value).toBe('Default');
  await click('Options');
  expect(dialog.open).toBe(true);
  const precision = dialog.querySelector('select')!;
  expect(precision.value).toBe('2');
  await act(async () => { precision.value = '3'; precision.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.600');
  expect(container.querySelector('.trail-duration[data-step="6"]')?.textContent).toBe('PLL 0.600s');
  expect(container.querySelector('[aria-label="Inspection time"]')).toBeNull();
  expect(localStorage.getItem('timer-time-precision')).toBe('3');
  await click('Close options');
  expect(dialog.open).toBe(false);
  await click('Options');
  expect(dialog.open).toBe(true);
  expect(precision.value).toBe('3');
  await act(async () => { precision.value = '2'; precision.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.60');
  expect(localStorage.getItem('timer-time-precision')).toBe('2');
  expect(save.mock.calls.flatMap(([solves]) => solves).at(-1)?.duration).toBe(600);
});

test('session summary shows current and best singles plus all four average sizes', async () => {
  await finishFirst();
  const records = container.querySelector('[aria-label="Session statistics"]')!.closest('section')!;
  const history = container.querySelector('[aria-label="Solve history"]')!.closest('section')!;
  expect(records).not.toBe(history);
  expect(records.querySelector('h2')!.textContent).toBe('Current / records');
  expect(history.querySelector('h2')!.textContent).toBe('Session history');
  expect(Array.from(history.querySelectorAll('thead th')).map(cell => cell.textContent)).toEqual(['Solve number', 'Time', 'Turns', 'TPS', 'View']);
  expect(history.querySelectorAll('tbody tr:first-child td')).toHaveLength(5);
  expect(history.querySelector('tbody button')?.textContent).toBe('View');
  expect(history.querySelector('input[type="file"]')).not.toBeNull();
  expect(records.querySelector('input[type="file"]')).toBeNull();
  const rows = Array.from(container.querySelectorAll('[aria-label="Session statistics"] tbody tr'));
  expect(rows.map(row => row.querySelector('th')!.textContent)).toEqual(['Single', 'Ao5', 'Ao12', 'Ao100', 'Ao1000']);
  expect(Array.from(rows[0].querySelectorAll('td')).map(cell => cell.textContent)).toEqual(['0.60', '0.60']);
  expect(rows.slice(1).every(row => Array.from(row.querySelectorAll('td')).every(cell => cell.textContent === '--'))).toBe(true);
});

test('a blocked preference save does not prevent switching display precision', async () => {
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  await click('Options');
  const precision = container.querySelector('select')!;
  await act(async () => { precision.value = '3'; precision.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.000');
  expect(container.querySelector('dialog [role="alert"]')?.textContent).toContain('could not save the preference');
});

test('automatically advances, preserves the last time, and replays buffered moves with their original host timing', async () => {
  await finishFirst();
  expect(container.querySelector('.timer-panel [role="img"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Next scramble');
  await act(async () => {
    emit({ type: 'FACELETS', timestamp: 1000, facelets: SOLVED });
    move('F', 1100); move('L2', 1200); move('L', 1300); move('L', 1400); move("F'", 1500);
  });
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('2.60');
  await act(async () => resolveNext('F L2'));
  const completed = save.mock.calls.flatMap(([solves]) => solves).filter(solve => solve.status === 'complete');
  expect(completed).toHaveLength(3);
  expect(completed[1]).toMatchObject({ duration: 600, penalty: 2000, scramble: 'R U2' });
  expect(completed[2]).toMatchObject({ duration: 200, scramble: 'F L2', status: 'complete' });
  expect(completed[2].moves.map(turn => [turn.move, turn.hostTime, turn.elapsed])).toEqual([
    ['L', 1300, 0], ['L', 1400, 100], ["F'", 1500, 200],
  ]);
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.20');
  expect(generate).toHaveBeenCalledTimes(3);
});

test('disconnect cancels pending advancement and discards buffered events', async () => {
  await finishFirst();
  await act(async () => move('F', 1000));
  await click('Disconnect');
  await act(async () => resolveNext('F L2'));
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Cube disconnected');
  expect(container.querySelector('[aria-label="Scramble"]')?.textContent).toContain('R');
  expect(container.querySelector('[role="img"]')?.getAttribute('data-facelets')).toBe(SOLVED);
  expect(save.mock.calls.flatMap(([solves]) => solves).filter(solve => solve.status === 'complete')).toHaveLength(2);
});

test.each([100, 500, 501])('an extra turn after %s ms updates the timer and history immediately, even during preparation', async delay => {
  await finishFirst();
  await act(async () => move('F', 900 + delay));
  const penalty = delay <= 500;
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe(penalty ? '2.60' : '0.60');
  const badge = container.querySelector('.timer-display .solve-penalty');
  expect(badge?.textContent ?? null).toBe(penalty ? '+2' : null);
  if (penalty) expect(badge?.classList.contains('text-bg-warning')).toBe(true);
  const row = container.querySelector('[aria-label="Solve history"] tbody tr')!;
  expect(row.children[1].textContent?.trim()).toBe(penalty ? '2.60s +2' : '0.60s');
  const saved = save.mock.calls.at(-1)![0][0];
  expect(saved.duration).toBe(600);
  expect(saved.moves.map(turn => turn.move)).toEqual(['U2', "R'"]);
  expect(saved.penalty).toBe(penalty ? 2000 : undefined);
  expect(saved.penaltyReason).toBe(penalty ? 'over-turn' : undefined);
  expect(container.querySelector('.timer-panel')?.textContent).not.toContain('over-turn');
  await act(async () => resolveNext('F L2'));
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe(penalty ? '2.60' : '0.60');
});

test.each(['Abort solve', 'Disconnect', 'snapshot mismatch'])('%s displays red DNF badges beside the timer and history time', async action => {
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); move('U', 300); });
  if (action === 'snapshot mismatch') await act(async () => emit({ type: 'FACELETS', timestamp: 400, facelets: SOLVED }));
  else await click(action);
  const badges = container.querySelectorAll('.solve-penalty');
  expect(badges).toHaveLength(2);
  badges.forEach(badge => {
    expect(badge.textContent).toBe('DNF');
    expect(badge.classList.contains('text-bg-danger')).toBe(true);
  });
  expect(container.querySelector('.timer-value + .solve-penalty')).not.toBeNull();
  expect(save.mock.calls.at(-1)![0][0].status).toBe('incomplete');
  expect(save.mock.calls.at(-1)![0][0].dnfReason).toBe(action === 'Abort solve' ? 'solve aborted' : 'solve interrupted');
  expect(container.querySelector('.timer-panel')?.textContent).not.toContain('Solve aborted by user.');
  expect(container.querySelector('[aria-label="Solve history"]')?.textContent).not.toMatch(/solve aborted|solve interrupted/);
});

test('extra-turn penalties default enabled, can be disabled immediately, and remember the preference', async () => {
  await finishFirst();
  await click('Options');
  const setting = container.querySelector<HTMLInputElement>('input[aria-describedby="over-turn-penalty-help"]')!;
  expect(setting.checked).toBe(true);
  await act(async () => setting.click());
  expect(localStorage.getItem('timer-over-turn-penalty')).toBe('false');
  await act(async () => move('F', 1000));
  expect(container.querySelector('.timer-display .solve-penalty')).toBeNull();
  expect(save.mock.calls.at(-1)![0][0].penalty).toBeUndefined();
  await act(async () => resolveNext('F L2'));
  await showHistory([]);
  expect(container.querySelector<HTMLInputElement>('input[aria-describedby="over-turn-penalty-help"]')!.checked).toBe(false);
  await click('Connect cube');
  await act(async () => { move('B', 2000); move('R2', 2100); move('R2', 2200); move("B'", 2300); });
  await act(async () => move('F', 2400));
  expect(save.mock.calls.at(-1)![0][0].penalty).toBeUndefined();
});

test('a stored disabled penalty preference can be enabled again without changing older solves', async () => {
  localStorage.setItem('timer-over-turn-penalty', 'false');
  await showHistory([]);
  await click('Options');
  const setting = container.querySelector<HTMLInputElement>('input[aria-describedby="over-turn-penalty-help"]')!;
  expect(setting.checked).toBe(false);
  await act(async () => setting.click());
  expect(localStorage.getItem('timer-over-turn-penalty')).toBe('true');
  await finishFirst();
  await act(async () => move('F', 1000));
  expect(save.mock.calls.at(-1)![0][0]).toMatchObject({ penalty: 2000, penaltyReason: 'over-turn' });
});

test('blocked preference storage defaults penalties on and still permits disabling them', async () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked'); });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked'); });
  await showHistory([]);
  await finishFirst();
  await click('Options');
  const setting = container.querySelector<HTMLInputElement>('input[aria-describedby="over-turn-penalty-help"]')!;
  expect(setting.checked).toBe(true);
  await act(async () => setting.click());
  expect(container.querySelector('.options-dialog')?.textContent).toContain('Penalty preference changed');
  await act(async () => move('F', 1000));
  expect(save.mock.calls.at(-1)![0][0].penalty).toBeUndefined();
});

test('restored history sorts by penalized totals and displays DNF instead of +2 for invalid attempts', async () => {
  await showHistory([
    { ...historySolve(1, 3000, 3), penalty: 2000 },
    historySolve(2, 4000, 4),
    { ...historySolve(3, 6000, 3, 'Default', 'incomplete'), penalty: 2000 },
  ]);
  await click('Time');
  expect(historyNumbers()).toEqual([2, 1, 3]);
  const cells = Array.from(container.querySelectorAll('[aria-label="Solve history"] tbody tr')).map(row => row.children[1].textContent?.trim());
  expect(cells).toEqual(['4.00s', '5.00s +2', '6.00s DNF']);
});

test.each([
  ['guided', ['U', "R'"]],
  ['alternative', ['U2', "U'", "R'"]],
] as const)('an aborted solve shows recovery guidance and generates a scramble after %s recovery', async (_name, recovery) => {
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); move('U', 300); });
  await click('Abort solve');
  expect(generate).toHaveBeenCalledTimes(1);
  expect(container.querySelector('.timer-panel')?.textContent).toContain('Return the cube to solved');
  expect(Array.from(container.querySelectorAll('.scramble-content .move')).map(move => move.textContent)).toEqual(['U', "R'"]);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="New scramble"]')?.disabled).toBe(true);
  const dnf = structuredClone(save.mock.calls.at(-1)![0][0]);
  const writes = save.mock.calls.length;
  for (let i = 0; i < recovery.length; i++) await act(async () => move(recovery[i], 400 + i * 100));
  expect(generate).toHaveBeenCalledTimes(2);
  expect(save.mock.calls).toHaveLength(writes);
  expect(save.mock.calls.at(-1)![0][0]).toEqual(dnf);
  await act(async () => resolveNext('F L2'));
  expect(container.querySelector('.timer-panel')?.textContent).not.toContain('Return the cube to solved');
  expect(Array.from(container.querySelectorAll('.scramble-content .move')).map(move => move.textContent)).toEqual(['F', 'L2']);
  expect(container.querySelector('.timer-display .solve-penalty')?.textContent).toBe('DNF');
  await act(async () => { move('F', 1000); move('L2', 1100); move('L2', 1200); move("F'", 1400); });
  expect(save.mock.calls.at(-1)![0][0]).toMatchObject({ status: 'complete', duration: 200, inspection: 100 });
  expect(save.mock.calls.at(-1)![0][0].id).not.toBe(dnf.id);
});

test('a solved authoritative snapshot during recovery starts a new scramble without modifying the DNF', async () => {
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); move('U', 300); });
  await click('Abort solve');
  const writes = save.mock.calls.length;
  physicalFacelets = SOLVED;
  await act(async () => emit({ type: 'FACELETS', timestamp: 500, facelets: SOLVED }));
  expect(generate).toHaveBeenCalledTimes(2);
  expect(save.mock.calls).toHaveLength(writes);
  await act(async () => resolveNext('F L2'));
  expect(container.querySelector('.scramble-content')?.textContent).toBe('FL2');
});

test('a move gap reads the actual cube state before offering DNF recovery', async () => {
  await click('Connect cube');
  await act(async () => { move('R', 100, 1); move('U2', 200, 2); move('U', 300, 3); });
  jest.mocked(cube.solution).mockResolvedValueOnce(["F'", 'U', "R'"]);
  await act(async () => move('F', 400, 5));
  expect(cube.solution).toHaveBeenLastCalledWith(physicalFacelets);
  expect(Array.from(container.querySelectorAll('.scramble-content .move')).map(move => move.textContent)).toEqual(["F'", 'U', "R'"]);
  const dnf = save.mock.calls.at(-1)![0][0];
  expect(dnf).toMatchObject({ status: 'incomplete', dnfReason: 'solve interrupted' });
  expect(dnf.moves.map(turn => turn.move)).toEqual(['U']);
  await act(async () => { move("F'", 500, 6); move('U', 600, 7); move("R'", 700, 8); });
  expect(generate).toHaveBeenCalledTimes(2);
  await act(async () => resolveNext('F L2'));
  expect(container.querySelector('.scramble-content')?.textContent).toBe('FL2');
});

test('scramble generation failure is recoverable and does not turn the previous solve into a DNF', async () => {
  await finishFirst();
  await act(async () => rejectNext(new Error('Worker failed.')));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Worker failed.');
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Read the cube state to retry');
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.60');
  expect(save.mock.calls.flatMap(([solves]) => solves).filter(solve => solve.status === 'incomplete')).toHaveLength(0);
  const retry = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Read cube state');
  expect(retry?.disabled).toBe(false);
});
