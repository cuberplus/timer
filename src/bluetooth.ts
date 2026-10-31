import { connectSmartCube, type SmartCubeConnection, type SmartCubeEvent } from 'smartcube-web-bluetooth';

export class BluetoothCube {
  connection: SmartCubeConnection | null = null;
  private unsubscribe: (() => void) | null = null;
  async connect(mac: string, event: (event: SmartCubeEvent) => void, connected: (connection: SmartCubeConnection) => void, status: (status: string) => void): Promise<void> {
    const started = performance.now(), log = (message: string, details: object | string = '') => console.info(`[Timer Bluetooth +${Math.round(performance.now() - started)}ms] ${message}`, details);
    const connection = await connectSmartCube({
      onStatus: message => { log('Connection stage', message); status(message); },
      macAddressProvider: async (device, fallback) => {
        log('Library requested MAC address', { deviceName: device.name, deviceId: device.id, fallback, enteredMAC: mac.trim() || null });
        if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac.trim())) throw new Error(mac.trim() ? 'MAC address must use AA:BB:CC:DD:EE:FF format.' : 'This cube needs its Bluetooth MAC address. Enter it and reconnect.');
        log('Providing manually entered MAC', mac.trim()); return mac.trim();
      },
    }).catch((failure: Error) => { console.error('[Timer Bluetooth] Library connection failed', { elapsedMs: Math.round(performance.now() - started), name: failure.name, message: failure.message, stack: failure.stack }, failure); throw failure; });
    this.connection = connection; try { if (connection.deviceMAC) { localStorage.setItem('timer-last-cube-mac', connection.deviceMAC); log('Remembered verified MAC', connection.deviceMAC); } } catch (failure) { console.warn('[Timer Bluetooth] Could not remember MAC; connection can continue', failure); }
    log('Library connection verified', { deviceName: connection.deviceName, deviceMAC: connection.deviceMAC, protocol: connection.protocol, capabilities: connection.capabilities }); connected(connection);
    const subscription = connection.events$.subscribe({
      next: sample => { event(sample); if (sample.type === 'GYRO') console.debug('[Timer Bluetooth] GYRO', sample); else log('Cube event', sample); },
      error: failure => { console.error('[Timer Bluetooth] Cube event stream failed', failure); event({ type: 'DISCONNECT', timestamp: performance.now() }); }, complete: () => log('Cube event stream closed'),
    });
    this.unsubscribe = () => subscription.unsubscribe(); log('Subscribed to cube events');
    if (connection.capabilities.facelets) { log('Sending REQUEST_FACELETS'); await connection.sendCommand({ type: 'REQUEST_FACELETS' }); log('REQUEST_FACELETS write completed'); }
    if (connection.capabilities.battery) { log('Sending REQUEST_BATTERY'); await connection.sendCommand({ type: 'REQUEST_BATTERY' }); log('REQUEST_BATTERY write completed'); } log('Connection setup complete; waiting for cube events');
  }
  async refresh(): Promise<void> {
    if (!this.connection?.capabilities.facelets) throw new Error('State requests unavailable. Physically solve and confirm calibration.');
    console.info('[Timer Bluetooth] Refresh: sending REQUEST_FACELETS'); await this.connection.sendCommand({ type: 'REQUEST_FACELETS' }); console.info('[Timer Bluetooth] Refresh write completed');
  }
  async disconnect(): Promise<void> {
    console.info('[Timer Bluetooth] Disconnect requested', { deviceName: this.connection?.deviceName, hasConnection: !!this.connection });
    this.unsubscribe?.(); this.unsubscribe = null;
    const connection = this.connection; this.connection = null;
    await connection?.disconnect(); console.info('[Timer Bluetooth] Disconnect completed');
  }
}
