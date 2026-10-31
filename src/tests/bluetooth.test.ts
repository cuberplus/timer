import { jest } from '@jest/globals';
import { Subject } from 'rxjs';
import type { SmartCubeConnection, SmartCubeEvent } from 'smartcube-web-bluetooth';

const connectSmartCube = jest.fn<typeof import('smartcube-web-bluetooth').connectSmartCube>();
jest.unstable_mockModule('smartcube-web-bluetooth', () => ({ connectSmartCube }));
const { BluetoothCube } = await import('../bluetooth');
const saved = new Map<string, string>();
const setItem = jest.fn((key: string, value: string) => { saved.set(key, value); });
const key = 'timer-last-cube-mac';
const info = jest.spyOn(console, 'info');
const errors = jest.spyOn(console, 'error');
const warnings = jest.spyOn(console, 'warn');
const debug = jest.spyOn(console, 'debug');

beforeEach(() => {
  for (const logger of [info, errors, warnings, debug]) logger.mockReset().mockImplementation(() => {});
  connectSmartCube.mockReset();
  setItem.mockReset().mockImplementation((key, value) => { saved.set(key, value); });
  saved.clear();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null, setItem,
  } });
});

afterAll(() => jest.restoreAllMocks());

function verifiedConnection(mac = 'AA:BB:CC:DD:EE:FF'): SmartCubeConnection {
  return {
    deviceName: 'Test cube', deviceMAC: mac, protocol: { id: 'test', name: 'Test' },
    capabilities: { facelets: false, battery: false, gyroscope: false, hardware: false, reset: false },
    events$: new Subject<SmartCubeEvent>(),
    sendCommand: jest.fn<SmartCubeConnection['sendCommand']>().mockResolvedValue(),
    disconnect: jest.fn<SmartCubeConnection['disconnect']>().mockResolvedValue(),
  };
}

test('remembers the verified address, not the input, only after verification finishes', async () => {
  saved.set(key, '11:22:33:44:55:66');
  let verify!: (connection: SmartCubeConnection) => void;
  connectSmartCube.mockReturnValue(new Promise(resolve => { verify = resolve; }));
  const adapter = new BluetoothCube();
  const pending = adapter.connect('00:00:00:00:00:00', () => {}, () => {}, () => {});
  expect(saved.get(key)).toBe('11:22:33:44:55:66');
  verify(verifiedConnection());
  await pending;
  expect(saved.get(key)).toBe('AA:BB:CC:DD:EE:FF');
  await adapter.disconnect();
});

test('a rejected connection does not replace the last working address', async () => {
  saved.set(key, '11:22:33:44:55:66');
  const failure = new Error('MAC verification failed.');
  connectSmartCube.mockRejectedValue(failure);
  await expect(new BluetoothCube().connect('00:00:00:00:00:00', () => {}, () => {}, () => {})).rejects.toThrow('MAC verification failed');
  expect(errors).toHaveBeenCalledWith('[Timer Bluetooth] Library connection failed', expect.objectContaining({ name: 'Error', message: failure.message, stack: failure.stack }), failure);
  expect(saved.get(key)).toBe('11:22:33:44:55:66');
  expect(setItem).not.toHaveBeenCalled();
});

test('a cube that does not use a MAC does not save an unverified input', async () => {
  saved.set(key, '11:22:33:44:55:66');
  connectSmartCube.mockResolvedValue(verifiedConnection(''));
  const adapter = new BluetoothCube();
  await adapter.connect('00:00:00:00:00:00', () => {}, () => {}, () => {});
  expect(saved.get(key)).toBe('11:22:33:44:55:66');
  expect(setItem).not.toHaveBeenCalled();
  await adapter.disconnect();
});

test('logs connection stages, the requested MAC, verified device, commands and notifications', async () => {
  const stream = new Subject<SmartCubeEvent>();
  const connection = { ...verifiedConnection(), events$: stream, capabilities: { ...verifiedConnection().capabilities, facelets: true, battery: true } };
  const status = jest.fn();
  connectSmartCube.mockImplementation(async options => {
    if (!options || typeof options === 'function') throw new Error('Expected connection options.');
    options.onStatus?.('Connecting…');
    expect(await options.macAddressProvider?.({ id: 'test-id', name: 'Test cube' } as BluetoothDevice, false)).toBe('AA:BB:CC:DD:EE:FF');
    options.onStatus?.('Verifying connection…');
    return connection;
  });
  const adapter = new BluetoothCube();
  const events = jest.fn<(event: SmartCubeEvent) => void>();
  await adapter.connect('AA:BB:CC:DD:EE:FF', events, () => {}, status);
  expect(status.mock.calls).toEqual([['Connecting…'], ['Verifying connection…']]);
  expect(info).toHaveBeenCalledWith(expect.stringMatching(/Connection stage$/), 'Verifying connection…');
  expect(info).toHaveBeenCalledWith(expect.stringMatching(/Library requested MAC address$/), expect.objectContaining({ deviceName: 'Test cube', enteredMAC: 'AA:BB:CC:DD:EE:FF', fallback: false }));
  expect(info).toHaveBeenCalledWith(expect.stringMatching(/Library connection verified$/), expect.objectContaining({ deviceName: 'Test cube', deviceMAC: connection.deviceMAC, capabilities: connection.capabilities }));
  expect(connection.sendCommand).toHaveBeenNthCalledWith(1, { type: 'REQUEST_FACELETS' });
  expect(connection.sendCommand).toHaveBeenNthCalledWith(2, { type: 'REQUEST_BATTERY' });
  expect(info).toHaveBeenCalledWith(expect.stringMatching(/Sending REQUEST_FACELETS$/), '');
  expect(info).toHaveBeenCalledWith(expect.stringMatching(/REQUEST_BATTERY write completed$/), '');
  const move: SmartCubeEvent = { type: 'MOVE', timestamp: 1, move: 'R', face: 1, direction: 0, localTimestamp: 1, cubeTimestamp: null };
  stream.next(move);
  expect(events).toHaveBeenCalledWith(move);
  expect(info).toHaveBeenCalledWith(expect.stringMatching(/Cube event$/), move);
  const gyro: SmartCubeEvent = { type: 'GYRO', timestamp: 2, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
  stream.next(gyro);
  expect(debug).toHaveBeenCalledWith('[Timer Bluetooth] GYRO', gyro);
  const failure = new Error('Notifications lost.');
  stream.error(failure);
  expect(errors).toHaveBeenCalledWith('[Timer Bluetooth] Cube event stream failed', failure);
  expect(events).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'DISCONNECT' }));
  await adapter.disconnect();
});

test('unavailable local storage does not prevent a verified connection', async () => {
  setItem.mockImplementation(() => { throw new DOMException('Storage blocked.', 'SecurityError'); });
  const connection = verifiedConnection();
  connectSmartCube.mockResolvedValue(connection);
  const adapter = new BluetoothCube();
  const connected = jest.fn();
  await adapter.connect('', () => {}, connected, () => {});
  expect(connected).toHaveBeenCalledWith(connection);
  await adapter.disconnect();
});
