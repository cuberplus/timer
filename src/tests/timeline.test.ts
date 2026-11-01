/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { deserialize, serialize } from 'node:v8';
import { Cube, inverse, loadCube } from '../puzzle';
import type { Solve } from '../engine';
import { SolveTimeline } from '../SolveTimeline';

let cube: Cube, root: Root, container: HTMLDivElement, solve: Solve;
const pll = "R U R' U' R' F R2 U' R' U' R U R' F'", oll = "R U R' U R U2 R'";
const scramble = `${pll} ${oll} R U R' F U F' L U L' B U B' D`;
beforeAll(async () => { cube = await loadCube(); });
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value: <T>(value: T): T => deserialize(serialize(value)) as T });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  solve = {
    version: 1, id: 'timeline-fixture', session: 'Test', createdAt: new Date().toISOString(), device: 'Test',
    scramble, startFacelets: cube.facelets(cube.solved().applyAlg(scramble)), duration: 0,
    status: 'active', reason: '', timingBasis: 'host', moves: [], orientations: [],
  };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
function append(alg: string) {
  alg.split(' ').forEach(move => {
    const elapsed = solve.moves.length * 100;
    solve.moves.push({ move, elapsed, hostTime: elapsed, localTimestamp: elapsed, cubeTimestamp: null });
    solve.duration = elapsed;
  });
}
async function draw(elapsed: number, precision: 2 | 3 = 2) {
  await act(async () => root.render(createElement(SolveTimeline, { cube, solve, elapsed, precision })));
}
const segments = () => Array.from(container.querySelectorAll<HTMLElement>('.trail-segment'));

test('moving tip leaves the old step color intact and separates recognition from execution', async () => {
  append('U');
  await draw(150);
  const crossColor = segments()[0].style.backgroundColor;
  const initialTip = container.querySelector<HTMLElement>('.trail-tip')!.style.left;
  append("U' D'");
  await draw(250);
  expect(container.querySelector<HTMLElement>('.trail-tip')!.style.left).not.toBe(initialTip);
  expect(segments()[0].style.backgroundColor).toBe(crossColor);
  const recognition = segments().find(segment => segment.dataset.step === '1')!;
  expect(recognition.dataset.phase).toBe('recognition');
  expect(recognition.classList.contains('recognition')).toBe(true);
  expect(recognition.style.backgroundColor).not.toBe(crossColor);
  expect(recognition.dataset.start).toBe('200');
  expect(recognition.dataset.end).toBe('250');
  append('B');
  await draw(350, 3);
  const pair = segments().filter(segment => segment.dataset.step === '1');
  expect(pair.map(segment => segment.dataset.phase)).toEqual(['recognition', 'execution']);
  expect(pair[0].style.backgroundColor).toBe(pair[1].style.backgroundColor);
  expect(pair[0].getAttribute('aria-label')).toBe('F2L Pair 1 recognition: 0.100s');
  expect(pair[1].getAttribute('aria-label')).toBe('F2L Pair 1 execution: 0.050s');
  const duration = container.querySelector('.trail-duration[data-step="1"]')!;
  expect(duration.textContent).toBe('F2L 1 0.150s');
  expect(duration.getAttribute('aria-label')).toBe('F2L Pair 1: 0.150s (in progress)');
  expect(duration.getAttribute('title')).toContain('0.100s recognition / 0.050s execution');
  expect(container.querySelector('.trail-duration[data-step="f2l"]')!.textContent).toBe('F2L 0.150s');
});

test.each([100, 100.125])('completed bar partitions the full solve with %sms intervals and honors display precision', async interval => {
  append("U U'");
  append(scramble.split(' ').reverse().map(inverse).join(' '));
  solve.moves.forEach((move, i) => { move.elapsed = move.hostTime = move.localTimestamp = i * interval; });
  solve.duration = solve.moves.at(-1)!.elapsed;
  solve.status = 'complete';
  await draw(solve.duration, 3);
  expect(container.querySelector<HTMLElement>('.trail-tip')!.style.left).toBe('100%');
  expect(segments().reduce((sum, segment) => sum + Number(segment.dataset.end) - Number(segment.dataset.start), 0)).toBe(Math.round(solve.duration));
  expect(segments().reduce((sum, segment) => sum + parseFloat(segment.style.width), 0)).toBeCloseTo(100, 8);
  expect(new Set(segments().map(segment => segment.dataset.step)).size).toBe(7);
  const labels = Array.from(container.querySelectorAll<HTMLElement>('.trail-duration'));
  expect(labels).toHaveLength(8);
  const major = Array.from(container.querySelectorAll<HTMLElement>('[aria-label="CFOP steps"] .trail-duration'));
  const pairs = Array.from(container.querySelectorAll<HTMLElement>('[aria-label="F2L sub-times"] .trail-duration'));
  expect(major.map(label => label.querySelector('strong')!.textContent)).toEqual(['Cross', 'F2L', 'OLL', 'PLL']);
  expect(pairs.map(label => label.querySelector('strong')!.textContent)).toEqual(['F2L 1', 'F2L 2', 'F2L 3', 'F2L 4']);
  expect(major.reduce((sum, label) => sum + Number(label.dataset.duration), 0)).toBe(Math.round(solve.duration));
  expect(Number(major[1].dataset.duration)).toBe(pairs.reduce((sum, label) => sum + Number(label.dataset.duration), 0));
  const bar = container.querySelector('.solve-trail')!;
  expect(bar.previousElementSibling!.getAttribute('aria-label')).toBe('CFOP steps');
  expect(bar.nextElementSibling!.getAttribute('aria-label')).toBe('F2L sub-times');
  expect(container.querySelector('.trail-duration[data-step="6"]')!.textContent).toMatch(/^PLL \d+\.\d{3}s$/);
  for (const text of ['Base cross', 'Darker:', 'lighter:', "first turn"]) expect(container.textContent).not.toContain(text);
  expect(container.querySelector('.badge')).toBeNull();
  await draw(solve.duration, 2);
  expect(container.querySelector('.trail-duration[data-step="6"]')!.textContent).toMatch(/^PLL \d+\.\d{2}s$/);
});

test('long active solves auto-rescale without dropping time, and unfinished stages stay pending', async () => {
  append("U U' D'");
  await draw(120000);
  const tip = parseFloat(container.querySelector<HTMLElement>('.trail-tip')!.style.left);
  expect(tip).toBeGreaterThan(0); expect(tip).toBeLessThan(100);
  for (const segment of segments()) expect(parseFloat(segment.style.left) + parseFloat(segment.style.width)).toBeLessThanOrEqual(100);
  expect(segments().reduce((sum, segment) => sum + Number(segment.dataset.end) - Number(segment.dataset.start), 0)).toBe(120000);
  solve.status = 'incomplete';
  await draw(solve.duration);
  expect(container.querySelector('.trail-duration[data-step="1"][data-status="pending"]')).not.toBeNull();
  expect(container.querySelector('.trail-duration[data-step="6"][data-status="unreached"]')!.textContent).toBe('PLL --');
});

test('F2L pairs use distinct shades within one purple hue family', async () => {
  append(scramble.split(' ').reverse().map(inverse).join(' '));
  solve.status = 'complete';
  await draw(solve.duration);
  const pairColors = [1, 2, 3, 4].map(i => container.querySelector<HTMLElement>(`.trail-duration[data-step="${i}"]`)!.style.borderTopColor);
  expect(new Set(pairColors).size).toBe(4);
  const hues = pairColors.map(color => {
    const [red, green, blue] = color.match(/\d+/g)!.map(Number);
    expect(blue).toBeGreaterThan(red); expect(red).toBeGreaterThan(green);
    return 240 + 60 * (red - green) / (blue - green);
  });
  expect(Math.max(...hues) - Math.min(...hues)).toBeLessThan(10);
});

test('crowded and zero-time labels remain readable on narrow bars and repack after resizing', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  let resize!: (width: number) => void;
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    constructor(callback: ResizeObserverCallback) { resize = width => callback([{ contentRect: { width } } as ResizeObserverEntry], this); }
    observe() {}
    unobserve() {}
    disconnect() {}
  } });
  try {
    append(scramble.split(' ').reverse().map(inverse).join(' '));
    solve.moves.forEach((move, i) => { move.elapsed = i === solve.moves.length - 1 ? 1000 : 0; });
    solve.duration = 1000; solve.status = 'complete';
    await draw(solve.duration, 3);
    await act(async () => resize(240));
    const labels = Array.from(container.querySelectorAll<HTMLElement>('.trail-duration'));
    expect(labels).toHaveLength(8);
    expect(labels.filter(label => label.textContent!.endsWith(' 0.000s'))).toHaveLength(7);
    const banks = Array.from(container.querySelectorAll('.trail-labels'));
    for (const bank of banks) {
      const labels = Array.from(bank.querySelectorAll<HTMLElement>('.trail-duration'));
      for (const row of new Set(labels.map(label => label.style.top))) {
        let edge = 0;
        for (const label of labels.filter(item => item.style.top === row)) {
          const center = parseFloat(label.style.left) / 100 * 240, half = parseFloat(label.style.width) / 2;
          expect(center - half).toBeGreaterThanOrEqual(edge - 0.001);
          expect(center + half).toBeLessThanOrEqual(240.001);
          edge = center + half;
        }
      }
    }
    await act(async () => resize(900));
    for (const bank of banks) expect(new Set(Array.from(bank.querySelectorAll<HTMLElement>('.trail-duration')).map(label => label.style.top)).size).toBe(1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'ResizeObserver', original);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
});
