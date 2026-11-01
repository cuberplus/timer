/** @jest-environment jsdom */
import { jest } from '@jest/globals';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import type { SmartCubeEvent } from 'smartcube-web-bluetooth';
import type { Solve } from '../engine';
import { sessionStats } from '../storage';
import { loadCube, SOLVED, Cube, inverse, isMove, movesOf, locations } from '../puzzle';

const cube = await loadCube();
const generate = jest.fn<() => Promise<string>>();
const save = jest.fn<(solves: Solve[]) => Promise<void>>().mockResolvedValue();
let emit: (event: SmartCubeEvent) => void;
await jest.unstable_mockModule('../puzzle', () => ({ Cube, SOLVED, inverse, isMove, movesOf, locations, loadCube: async () => cube, generateScramble: generate }));
await jest.unstable_mockModule('../bluetooth', () => ({ BluetoothCube: class {
  connection: { deviceName: string } | null = null;
  async connect(_mac: string, events: typeof emit, ready: (device: { deviceName: string }) => void) {
    emit = events;
    this.connection = { deviceName: 'Test cube' };
    ready(this.connection);
    emit({ type: 'FACELETS', timestamp: 0, facelets: SOLVED });
  }
  async disconnect() { this.connection = null; }
} }));
await jest.unstable_mockModule('../storage', () => ({
  saveSolves: save, readSolves: async () => [], backupJSON: () => '', validateBackup: () => [],
  cubeastCSV: () => '', sessionStats, turns: (solve: Solve) => solve.moves.length,
  formatTime: (ms: number, precision: 2 | 3 = 2) => (ms / 1000).toFixed(precision),
}));
await jest.unstable_mockModule('../CubeView', () => ({
  CubeView: ({ facelets }: { facelets: string }) => createElement('div', { role: 'img', 'aria-label': 'Live 3x3 cube state', 'data-facelets': facelets }),
}));
await jest.unstable_mockModule('../Replay', () => ({ Replay: () => null }));
const { default: App } = await import('../App');

let root: Root, container: HTMLDivElement, resolveNext: (scramble: string) => void, rejectNext: (error: Error) => void;
beforeEach(async () => {
  localStorage.removeItem('timer-time-precision');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value: <T>(value: T): T => deserialize(serialize(value)) as T });
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => webcrypto.randomUUID() });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: {} });
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(performance, 'now').mockReturnValue(0);
  save.mockClear(); generate.mockReset();
  generate.mockResolvedValueOnce('R U2').mockImplementationOnce(() => new Promise<string>((resolve, reject) => { resolveNext = resolve; rejectNext = reject; })).mockResolvedValue('B R2');
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(App)); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.restoreAllMocks(); });

async function click(name: string) {
  const button = Array.from(container.querySelectorAll('button')).find(element => element.textContent === name);
  expect(button).toBeDefined(); expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}
function move(notation: string, hostTime: number) {
  jest.mocked(performance.now).mockReturnValue(hostTime);
  emit({ type: 'MOVE', timestamp: hostTime, move: notation, face: 0, direction: 0, localTimestamp: hostTime, cubeTimestamp: null });
}
async function finishFirst() {
  await click('Connect cube');
  await act(async () => { move('R', 100); move('U2', 200); move('U2', 300); move("R'", 900); });
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.60');
  expect(generate).toHaveBeenCalledTimes(2);
  expect(container.querySelector('.trail-duration[data-step="6"][data-status="done"]')).not.toBeNull();
}

test('cube card omits redundant instructions while preserving highlighting and correction messages', async () => {
  await click('Connect cube');
  const panel = container.querySelector('.timer-panel')!;
  const checkText = () => {
    expect(panel.textContent).not.toMatch(/Follow the highlighted|Next:|Last solve|Use the cube's calibrated face/);
    expect(panel.querySelector('.next-move')).toBeNull();
  };
  checkText();
  expect(container.querySelector('.scramble .current')?.textContent).toBe('R');
  await act(async () => move('F', 100));
  expect(panel.querySelector('[role="status"]')?.textContent).toContain('Wrong turn.');
  expect(container.textContent).toContain("Correction: F'");
  await act(async () => move("F'", 200));
  checkText();
  await act(async () => { move('R', 300); move('U2', 400); move('U2', 500); move("R'", 1100); });
  checkText();
  expect(panel.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.60');
  await act(async () => resolveNext('F L2'));
  checkText();
  expect(container.querySelector('.scramble .current')?.textContent).toBe('F');
});

test('shows CFOP milestones during an active solve without exporting', async () => {
  const pll = "R U R' U' R' F R2 U' R' U' R U R' F'", oll = "R U R' U R U2 R'";
  const scramble = `${pll} ${oll} R U R' F U F' L U L' B U B' D`;
  generate.mockReset().mockResolvedValueOnce(scramble).mockResolvedValue('B R2');
  await click('Connect cube');
  await act(async () => scramble.split(' ').forEach((turn, i) => move(turn, i * 100)));
  expect(container.querySelector('[aria-label="CFOP steps"]')).toBeNull();
  await act(async () => move("D'", 4000));
  expect(container.textContent).toContain('1 reported moves recorded');
  expect(container.querySelector('.trail-duration[data-step="0"][data-status="done"]')).not.toBeNull();
  expect(container.querySelector('.trail-duration[data-step="1"][data-status="pending"]')).not.toBeNull();
  await act(async () => { move('B', 4100); move("U'", 4200); move("B'", 4300); });
  expect(container.querySelector('.trail-duration[data-step="1"][data-status="done"]')).not.toBeNull();
  expect(container.querySelector('.trail-duration[data-step="2"][data-status="pending"]')).not.toBeNull();
  expect(container.querySelector('.trail-duration[data-step="6"]')).toBeNull();
  expect(save.mock.calls.flatMap(([solves]) => solves).every(solve => solve.status === 'active')).toBe(true);
});

test('options change timer and CFOP precision immediately and remember the preference', async () => {
  await finishFirst();
  const precision = container.querySelector('select')!;
  expect(precision.value).toBe('2');
  await act(async () => { precision.value = '3'; precision.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.600');
  expect(container.querySelector('.trail-duration[data-step="6"]')?.textContent).toBe('0.600s');
  expect(localStorage.getItem('timer-time-precision')).toBe('3');
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
  expect(history.querySelector('input[type="file"]')).not.toBeNull();
  expect(records.querySelector('input[type="file"]')).toBeNull();
  const rows = Array.from(container.querySelectorAll('[aria-label="Session statistics"] tbody tr'));
  expect(rows.map(row => row.querySelector('th')!.textContent)).toEqual(['Single', 'Ao5', 'Ao12', 'Ao100', 'Ao1000']);
  expect(Array.from(rows[0].querySelectorAll('td')).map(cell => cell.textContent)).toEqual(['0.60', '0.60']);
  expect(rows.slice(1).every(row => Array.from(row.querySelectorAll('td')).every(cell => cell.textContent === '--'))).toBe(true);
});

test('a blocked preference save does not prevent switching display precision', async () => {
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  const precision = container.querySelector('select')!;
  await act(async () => { precision.value = '3'; precision.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.000');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not save the preference');
});

test('automatically advances, preserves the last time, and replays buffered moves with their original host timing', async () => {
  await finishFirst();
  expect(container.querySelector('.timer-panel [role="img"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Next scramble');
  await act(async () => {
    emit({ type: 'FACELETS', timestamp: 1000, facelets: SOLVED });
    move('F', 1100); move('L2', 1200); move('L', 1300); move('L', 1400); move("F'", 1500);
  });
  expect(container.querySelector('[aria-label="Solve time"]')?.textContent).toBe('0.60');
  await act(async () => resolveNext('F L2'));
  const completed = save.mock.calls.flatMap(([solves]) => solves).filter(solve => solve.status === 'complete');
  expect(completed).toHaveLength(2);
  expect(completed[1]).toMatchObject({ duration: 200, scramble: 'F L2', status: 'complete' });
  expect(completed[1].moves.map(turn => [turn.move, turn.hostTime, turn.elapsed])).toEqual([
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
  expect(save.mock.calls.flatMap(([solves]) => solves).filter(solve => solve.status === 'complete')).toHaveLength(1);
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
