/** @jest-environment jsdom */
import { jest } from '@jest/globals';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { deserialize, serialize } from 'node:v8';
import type { Solve } from '../engine';
import { inverse, loadCube } from '../puzzle';
import { analyzeCFOP, CFOP_STEPS } from '../cfop';

await jest.unstable_mockModule('../CubeView', () => ({
  CubeView: ({ facelets }: { facelets: string }) => createElement('div', { 'data-facelets': facelets, 'aria-label': 'Replay cube' }),
}));
const { Replay } = await import('../Replay');
const cube = await loadCube();
const pll = "R U R' U' R' F R2 U' R' U' R U R' F'", oll = "R U R' U R U2 R'";
const scramble = `${pll} ${oll} R U R' F U F' L U L' B U B' D`;
let root: Root, container: HTMLDivElement;
const close = jest.fn();
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value: <T>(value: T): T => deserialize(serialize(value)) as T });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  close.mockClear();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.useRealTimers(); });

function recording(scramble: string, solution: string, status: Solve['status'] = 'complete'): Solve {
  const moves = solution.split(/\s+/).filter(Boolean).map((move, index) => ({
    move, elapsed: index * 100, hostTime: index * 100, localTimestamp: index * 100, cubeTimestamp: null,
  }));
  return {
    version: 1, id: 'replay-fixture', session: 'Test', createdAt: new Date().toISOString(), device: 'Test',
    scramble, startFacelets: cube.facelets(cube.solved().applyAlg(scramble)), duration: moves.at(-1)?.elapsed ?? 0,
    status, reason: '', timingBasis: 'host', moves, orientations: [],
  };
}
async function draw(solve: Solve) {
  await act(async () => root.render(createElement(Replay, { cube, solve, close, precision: 3 })));
}
async function click(text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent === text)!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}
const groups = () => Array.from(container.querySelectorAll('[aria-label="Solution steps"] > [role="group"]'));
const position = () => container.querySelector<HTMLInputElement>('[aria-label="Replay move"]')!.value;
const facelets = () => container.querySelector('[aria-label="Replay cube"]')!.getAttribute('data-facelets');

test('opens replay as a modal and closes with its button or Escape', async () => {
  await draw(recording('R', "R'"));
  const dialog = container.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(dialog.getAttribute('aria-labelledby')).toBe('replay-title');
  await click('Close replay');
  expect(dialog.open).toBe(false);
  expect(close).toHaveBeenCalledTimes(1);
  dialog.showModal();
  await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(dialog.open).toBe(false);
  expect(close).toHaveBeenCalledTimes(2);
});

test('shows the original solve GUID at the very bottom and distinguishes recorded from missing inspection', async () => {
  const solve = { ...recording('R', "R'"), id: 'd01e4c06-25db-4f27-b14c-ceacff0b5176', inspection: 2345 };
  await draw(solve);
  const dialog = container.querySelector('dialog')!;
  expect(dialog.lastElementChild!.getAttribute('aria-label')).toBe('Solve ID');
  expect(dialog.lastElementChild!.textContent).toBe(`Solve ID: ${solve.id}`);
  expect(container.querySelector('[aria-label="Inspection time"]')!.textContent).toBe('Inspection: 2.345s');
  await draw(recording('R', "R'"));
  expect(container.querySelector('[aria-label="Inspection time"]')!.textContent).toBe('Inspection: Not recorded');
});

test.each([
  { status: 'complete' as const, penalty: 2000 as const, penaltyReason: 'over-turn' as const, expected: '+2 reason: over-turn' },
  { status: 'incomplete' as const, dnfReason: 'solve aborted' as const, expected: 'DNF reason: solve aborted' },
  { status: 'incomplete' as const, dnfReason: 'solve interrupted' as const, expected: 'DNF reason: solve interrupted' },
])('shows $expected only inside the solve view without changing replay timing', async ({ expected, ...fields }) => {
  const solve = { ...recording('R U', "U' R'"), ...fields };
  const original = structuredClone(solve);
  await draw(solve);
  const reason = container.querySelector('[aria-label="Penalty reason"]')!;
  expect(reason.textContent).toBe(expected);
  expect(reason.closest('dialog')?.open).toBe(true);
  await click('Next move');
  expect(position()).toBe('1');
  expect(solve).toEqual(original);
});

test('legacy reasons are displayed and DNF takes precedence over an earlier +2', async () => {
  await draw({ ...recording('R', "R'"), penalty: 2000 });
  expect(container.querySelector('[aria-label="Penalty reason"]')?.textContent).toBe('+2 reason: over-turn');
  await draw({ ...recording('R', "R'", 'incomplete'), penalty: 2000, reason: 'Solve aborted by user.' });
  expect(container.querySelector('[aria-label="Penalty reason"]')?.textContent).toBe('DNF reason: solve aborted');
  await draw(recording('R', "R'"));
  expect(container.querySelector('[aria-label="Penalty reason"]')).toBeNull();
});

test('solution is partitioned into the same seven CFOP milestones as the timeline', async () => {
  const solve = recording(scramble, scramble.split(' ').reverse().map(inverse).join(' '));
  const original = structuredClone(solve), { ends } = analyzeCFOP(solve, cube);
  await draw(solve);
  expect(groups().map(group => group.querySelector('h3')!.textContent)).toEqual(['Cross', 'F2L Pair 1', 'F2L Pair 2', 'F2L Pair 3', 'F2L Pair 4', 'OLL', 'PLL']);
  for (let step = 0; step < CFOP_STEPS.length; step++) {
    const recorded = solve.moves.slice(ends[step - 1] ?? 0, ends[step]).map(move => move.move).join(' ');
    const displayed = Array.from(groups()[step].querySelectorAll('button')).map(button => button.textContent).join(' ');
    expect(cube.equals(cube.solved().applyAlg(recorded), cube.solved().applyAlg(displayed))).toBe(true);
  }
  await act(async () => (groups()[6].querySelector('button:last-child') as HTMLButtonElement).click());
  expect(position()).toBe(String(solve.moves.length));
  expect(facelets()).toBe(cube.facelets(cube.solved()));
  expect(solve).toEqual(original);
});

test('repeated turns compact within a step without combining across a milestone', async () => {
  const rest = scramble.split(' ').slice(0, -1).reverse().map(inverse).join(' ');
  const solve = recording(scramble.slice(0, -1) + 'D2', `D D D D D D ${rest}`);
  await draw(solve);
  expect(groups()[0].querySelector('button')!.textContent).toBe('D2');
  const firstPair = groups()[1].querySelector('button')!;
  expect(firstPair.textContent).toBe('D4');
  expect(firstPair.getAttribute('aria-label')).toContain('D D D D');
  await act(async () => firstPair.click());
  expect(position()).toBe('6');
  expect(facelets()).toBe(cube.facelets(cube.parse(solve.startFacelets).applyAlg('D2')));
});

test('combined turns seek to the last raw move while next, previous and playback preserve intermediate states', async () => {
  const solve = recording('U2', "D D U' U'", 'incomplete');
  await draw(solve);
  const buttons = groups()[6].querySelectorAll('button');
  expect(Array.from(buttons).map(button => button.textContent)).toEqual(['D2', 'U2']);
  expect(groups().slice(0, 6).every(group => group.textContent!.includes('Skipped'))).toBe(true);
  expect(buttons[0].title).toBe('0.100s');
  await click('Next move');
  expect(position()).toBe('1');
  expect(facelets()).toBe(cube.facelets(cube.parse(solve.startFacelets).applyMove('D')));
  expect(buttons[0].classList.contains('partial')).toBe(true);
  await act(async () => buttons[0].click());
  expect(position()).toBe('2');
  expect(facelets()).toBe(cube.facelets(cube.parse(solve.startFacelets).applyAlg('D2')));
  expect(buttons[0].classList.contains('done')).toBe(true);
  expect(buttons[0].classList.contains('current')).toBe(true);
  expect(buttons[0].classList.contains('partial')).toBe(false);
  await click('Previous move');
  expect(position()).toBe('1');
  jest.useFakeTimers();
  await click('Play');
  await act(async () => jest.advanceTimersByTime(100));
  expect(position()).toBe('2');
  await act(async () => jest.advanceTimersByTime(100));
  expect(position()).toBe('3');
  expect(facelets()).toBe(cube.facelets(cube.parse(solve.startFacelets).applyAlg("D D U'")));
  expect(buttons[1].classList.contains('partial')).toBe(true);
  await act(async () => buttons[1].click());
  expect(position()).toBe('4');
  expect(buttons[1].classList.contains('done')).toBe(true);
  expect(buttons[1].classList.contains('current')).toBe(true);
  expect(buttons[0].classList.contains('current')).toBe(false);
});

test('single moves stay highlighted when stepping, seeking and playing across solve steps', async () => {
  await draw(recording(scramble, "D' B U'", 'incomplete'));
  const buttons = container.querySelectorAll<HTMLButtonElement>('.move-timeline button');
  const current = () => Array.from(container.querySelectorAll('.move-timeline .current')).map(button => button.textContent);
  expect(current()).toEqual(["D'"]);
  await click('Next move');
  expect(current()).toEqual(["D'"]);
  expect(buttons[0].getAttribute('aria-current')).toBe('step');
  await click('Next move');
  expect(current()).toEqual(['B']);
  expect(buttons[0].hasAttribute('aria-current')).toBe(false);
  await click('Previous move');
  expect(current()).toEqual(["D'"]);
  await act(async () => buttons[2].click());
  expect(current()).toEqual(["U'"]);
  const slider = container.querySelector<HTMLInputElement>('[aria-label="Replay move"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '0');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(position()).toBe('0');
  expect(current()).toEqual(["D'"]);
  jest.useFakeTimers();
  await click('Play');
  await act(async () => jest.advanceTimersByTime(20));
  expect(current()).toEqual(["D'"]);
  await act(async () => jest.advanceTimersByTime(100));
  expect(current()).toEqual(['B']);
  await act(async () => jest.advanceTimersByTime(100));
  expect(current()).toEqual(["U'"]);
  expect(container.querySelector('.move-timeline .partial')).toBeNull();
});

test('unfinished solutions retain their moves and mark unreached steps instead of dropping the attempt', async () => {
  await draw(recording(scramble, "D' B U'", 'incomplete'));
  expect(groups()[0].querySelector('button')!.textContent).toBe("D'");
  expect(Array.from(groups()[1].querySelectorAll('button')).map(button => button.textContent)).toEqual(['B', "U'"]);
  expect(groups().slice(2).every(group => group.textContent!.includes('Not reached'))).toBe(true);
});
