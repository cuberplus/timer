/** @jest-environment jsdom */
import { jest } from '@jest/globals';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { deserialize, serialize } from 'node:v8';
import { loadCube, SOLVED } from '../puzzle';
import type { KTransformation } from 'cubing/kpuzzle';
import type { TwistyPlayerConfig } from 'cubing/twisty';

const setup = jest.fn<(value: KTransformation | null) => void>();
const timeline = jest.fn<(value: { animLeaf: { toString(): string }; start: number; end: number }[]) => void>();
const pause = jest.fn();
let timestamps: number[] = [];
const construct = jest.fn<(config: TwistyPlayerConfig) => HTMLElement>(() => {
  const element = Object.assign(document.createElement('div'), {
    experimentalModel: { setupTransformation: { set: setup }, animationTimelineLeavesRequest: { set: timeline } },
    pause,
  });
  Object.defineProperty(element, 'timestamp', { set: (value: number) => timestamps.push(value) });
  return element;
});
await jest.unstable_mockModule('cubing/twisty', () => ({ TwistyPlayer: construct }));
const { CubeView } = await import('../CubeView');
const cube = await loadCube();
let root: Root, container: HTMLDivElement, clock: number, nextFrame: number;
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value: <T>(value: T): T => deserialize(serialize(value)) as T });
  setup.mockClear(); timeline.mockClear(); construct.mockClear(); pause.mockClear(); timestamps = [];
  clock = 0; nextFrame = 0; frames = new Map();
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++nextFrame, callback); return nextFrame;
  });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.restoreAllMocks(); });

async function draw(moves: string[], position = moves.length, animateSeeks = false, speed = 1, start = SOLVED) {
  const facelets = cube.facelets(cube.parse(start).applyAlg(moves.slice(0, position).join(' ')));
  await act(async () => root.render(createElement(CubeView, { cube, facelets, moves, position, animateSeeks, speed })));
}
function frame(milliseconds = 25) {
  clock += milliseconds;
  const pending = [...frames.values()]; frames.clear();
  pending.forEach(callback => callback(clock));
}

test('hides back-side hint stickers and starts at the supplied snapshot without animating', async () => {
  const start = cube.facelets(cube.solved().applyAlg('F D'));
  await draw(['R', 'U2'], 1, false, 1, start);
  expect(construct.mock.calls[0][0].hintFacelets).toBe('none');
  expect(setup).toHaveBeenLastCalledWith(cube.parse(start).experimentalToTransformation());
  expect(timestamps.at(-1)).toBe(1000);
  expect(frames.size).toBe(0);
});

test('live bursts retain and animate every raw turn, including repeated and opposite-face moves', async () => {
  const moves: string[] = [];
  await draw(moves, 0, true);
  moves.push('R', 'R', 'L');
  await draw(moves, 3, true);
  expect(timeline.mock.calls.at(-1)![0].map(leaf => [leaf.animLeaf.toString(), leaf.start, leaf.end])).toEqual([
    ['R', 0, 1000], ['R', 1000, 2000], ['L', 2000, 3000],
  ]);
  frame(); expect(timestamps.at(-1)).toBe(250);
  // Appending while a turn is in flight must preserve its progress.
  moves.push("U'");
  await draw(moves, 4, true);
  expect(timestamps.at(-1)).toBe(250);
  for (let i = 0; i < 15; i++) frame();
  expect(timestamps).toEqual(expect.arrayContaining([500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]));
  expect(frames.size).toBe(0);
  expect(setup).toHaveBeenCalledTimes(1);
});

test('replay animates single forward and backward moves, respects speed, and snaps larger seeks', async () => {
  const moves = ['R', 'U', 'F'];
  await draw(moves, 0);
  await draw(moves, 1);
  frame(); expect(timestamps.at(-1)).toBe(250);
  frame(); frame(); frame(); expect(timestamps.at(-1)).toBe(1000);
  await draw(moves, 0);
  frame(); expect(timestamps.at(-1)).toBe(750);
  frame(); frame(); frame(); expect(timestamps.at(-1)).toBe(0);
  await draw(moves, 1, false, 2);
  frame(); expect(timestamps.at(-1)).toBe(500);
  await draw(moves, 3);
  expect(timestamps.at(-1)).toBe(3000);
  expect(frames.size).toBe(0);
});

test('resynchronization cancels stale animation, and a delayed frame cannot skip a whole turn', async () => {
  const moves: string[] = [];
  await draw(moves, 0, true);
  moves.push('R', 'U');
  await draw(moves, 2, true);
  frame(2000); expect(timestamps.at(-1)).toBe(950);
  const start = cube.facelets(cube.solved().applyMove('F'));
  await draw([], 0, true, 1, start);
  expect(timestamps.at(-1)).toBe(0);
  expect(setup).toHaveBeenLastCalledWith(cube.parse(start).experimentalToTransformation());
  expect(frames.size).toBe(0);
});

test('unmount cancels the animation and removes the player', async () => {
  const moves: string[] = [];
  await draw(moves, 0, true);
  moves.push('R');
  await draw(moves, 1, true);
  expect(frames.size).toBe(1);
  await act(async () => root.unmount());
  expect(frames.size).toBe(0);
  expect(pause).toHaveBeenCalled();
  expect(container.children).toHaveLength(0);
});
