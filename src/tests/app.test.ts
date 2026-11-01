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
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
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
  const button = Array.from(container.querySelectorAll('button')).find(element => element.textContent === name || element.getAttribute('aria-label') === name);
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
  expect(container.querySelector('.trail-duration[data-step="6"]')?.textContent).toBe('0.600s');
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
  expect(Array.from(history.querySelectorAll('thead th')).map(cell => cell.textContent)).toEqual(['Time', 'Turns', 'TPS', 'View']);
  expect(history.querySelectorAll('tbody tr:first-child td')).toHaveLength(4);
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
