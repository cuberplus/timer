/** @jest-environment jsdom */
import { jest } from '@jest/globals';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useScreenWakeLock } from '../useScreenWakeLock';

const request = jest.fn<(type: WakeLockType) => Promise<WakeLockSentinel>>();
let root: Root, container: HTMLDivElement;

function sentinel() {
  const lock = Object.assign(new EventTarget(), {
    released: false,
    type: 'screen' as const,
    onrelease: null,
    release: jest.fn<() => Promise<void>>().mockImplementation(async () => {
      lock.released = true;
      lock.dispatchEvent(new Event('release'));
    }),
  });
  return lock;
}

function App() { useScreenWakeLock(); return null; }
async function mount() { await act(async () => root.render(createElement(App))); }
async function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
  request.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, 'wakeLock');
  Reflect.deleteProperty(document, 'visibilityState');
});

test('keeps the visible site awake, releases in the background, and reacquires on return', async () => {
  const first = sentinel(), second = sentinel();
  request.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  await mount();
  expect(request).toHaveBeenCalledWith('screen');
  await act(async () => { document.dispatchEvent(new Event('pointerdown')); });
  expect(request).toHaveBeenCalledTimes(1);
  await visibility('hidden');
  expect(first.release).toHaveBeenCalledTimes(1);
  await visibility('visible');
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
  expect(second.release).toHaveBeenCalledTimes(1);
  await visibility('visible');
  await act(async () => { document.dispatchEvent(new Event('pointerdown')); });
  expect(request).toHaveBeenCalledTimes(2);
});

test('unsupported browsers can still mount the app', async () => {
  Reflect.deleteProperty(navigator, 'wakeLock');
  await mount();
  await visibility('visible');
  expect(request).not.toHaveBeenCalled();
});

test('denied requests are harmless and a later interaction can retry', async () => {
  request.mockRejectedValueOnce(new Error('Not allowed')).mockResolvedValueOnce(sentinel());
  await mount();
  await act(async () => { document.dispatchEvent(new Event('pointerdown')); });
  expect(request).toHaveBeenCalledTimes(2);
});

test('waits until the page is visible before requesting a lock', async () => {
  await visibility('hidden');
  request.mockResolvedValueOnce(sentinel());
  await mount();
  expect(request).not.toHaveBeenCalled();
  await visibility('visible');
  expect(request).toHaveBeenCalledTimes(1);
});

test.each(['hidden', 'unmounted'])('releases a pending lock when the app is %s', async state => {
  const lock = sentinel();
  let resolve: (lock: WakeLockSentinel) => void = () => {};
  request.mockImplementationOnce(() => new Promise(result => { resolve = result; }));
  await mount();
  await act(async () => { document.dispatchEvent(new Event('pointerdown')); });
  expect(request).toHaveBeenCalledTimes(1);
  if (state === 'hidden') await visibility('hidden');
  else await act(async () => root.unmount());
  await act(async () => resolve(lock));
  expect(lock.release).toHaveBeenCalledTimes(1);
});

test('can reacquire after the system releases the lock', async () => {
  const lock = sentinel();
  request.mockResolvedValueOnce(lock).mockResolvedValueOnce(sentinel());
  await mount();
  await lock.release();
  await act(async () => { document.dispatchEvent(new Event('pointerdown')); });
  expect(request).toHaveBeenCalledTimes(2);
});
