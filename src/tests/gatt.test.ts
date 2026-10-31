import { jest } from '@jest/globals';
const { connectSmartCube } = jest.requireActual<typeof import('smartcube-web-bluetooth')>('smartcube-web-bluetooth');

const connect = jest.fn<() => Promise<BluetoothRemoteGATTServer>>();
const discover = jest.fn<() => Promise<BluetoothRemoteGATTService[]>>();
const disconnect = jest.fn();
const status = jest.fn<(message: string) => void>();
const gatt: BluetoothRemoteGATTServer = {
  get device() { return device; }, connected: false, connect, getPrimaryServices: discover, disconnect,
  getPrimaryService: jest.fn<(service: BluetoothServiceUUID) => Promise<BluetoothRemoteGATTService>>(),
};
const device = Object.assign(new EventTarget(), { name: 'WCU_MY33_1234', id: 'test-cube', gatt }) as BluetoothDevice;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

beforeEach(() => {
  jest.useFakeTimers();
  connect.mockReset().mockResolvedValue(gatt);
  discover.mockReset().mockResolvedValue([{ uuid: '0783b03e-7735-b5a0-1760-a305d2795cb0' } as BluetoothRemoteGATTService]);
  disconnect.mockReset();
  status.mockReset();
  for (const method of ['info', 'warn', 'error'] as const) jest.spyOn(console, method).mockImplementation(() => {});
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { bluetooth: {
    requestDevice: jest.fn<() => Promise<BluetoothDevice>>().mockResolvedValue(device),
  } } });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

test.each(['connect', 'discover'])('a stalled GATT %s operation times out, disconnects, and never silently retries', async operation => {
  if (operation === 'connect') connect.mockReturnValue(new Promise(() => {}));
  else discover.mockReturnValue(new Promise(() => {}));
  const stage = operation === 'connect' ? 'Opening Bluetooth GATT connection' : 'Discovering Bluetooth services';
  const pending = expect(connectSmartCube({ onStatus: status })).rejects.toThrow(`${stage} timed out after 15 seconds`);
  await jest.advanceTimersByTimeAsync(15000);
  await pending;
  expect(status).toHaveBeenLastCalledWith(stage);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  await jest.advanceTimersByTimeAsync(60000);
  expect(connect).toHaveBeenCalledTimes(1);
});

test('successful GATT setup reports both steps, reaches the MoYu MAC provider, and clears deadlines', async () => {
  const macAddressProvider = jest.fn<() => Promise<string | null>>().mockRejectedValue(new Error('MAC provider reached.'));
  await expect(connectSmartCube({ onStatus: status, macAddressProvider })).rejects.toThrow('MAC provider reached.');
  expect(status.mock.calls.map(([message]) => message)).toContain('Opening Bluetooth GATT connection');
  expect(status.mock.calls.map(([message]) => message)).toContain('Discovering Bluetooth services');
  expect(macAddressProvider).toHaveBeenCalledWith(device, false);
  expect(jest.getTimerCount()).toBe(0);
});

test('native discovery failures preserve the original exception and clean up the connection', async () => {
  const failure = new DOMException('Bluetooth service discovery failed.', 'NetworkError');
  discover.mockRejectedValue(failure);
  await expect(connectSmartCube({ onStatus: status })).rejects.toBe(failure);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});
