import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { SmartCubeEvent } from 'smartcube-web-bluetooth';
import { BluetoothCube } from './bluetooth';
import { TimerEngine, type Solve } from './engine';
import { generateScramble, inverse, loadCube, SOLVED, type Cube } from './puzzle';
import { backupJSON, cubeastCSV, formatTime, readSolves, saveSolves, sessionStats, turns, validateBackup } from './storage';
import { CubeView } from './CubeView';
import { Replay } from './Replay';
import { SolveTimeline } from './SolveTimeline';

const errorText = (error: Error): string => error.message || 'The operation failed.';
const labels = { disconnected: 'Disconnected', synchronizing: 'Synchronizing', scrambling: 'Scrambling', ready: 'Ready', solving: 'Solving', finished: 'Finished', recovery: 'Resynchronize' };

export default function App() {
  const [, render] = useReducer(n => n + 1, 0);
  const [cube, setCube] = useState<Cube | null>(null);
  const [history, setHistory] = useState<Solve[]>([]);
  const [error, setError] = useState('');
  const [storage, setStorage] = useState('Loading local history...');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [demo, setDemo] = useState(false);
  const [battery, setBattery] = useState<number | null>(null);
  const [mac, setMac] = useState(() => { try { return localStorage.getItem('timer-last-cube-mac') ?? ''; } catch { return ''; } });
  const [precision, setPrecision] = useState<2 | 3>(() => { try { return localStorage.getItem('timer-time-precision') === '3' ? 3 : 2; } catch { return 2; } });
  const [session, setSession] = useState('Default');
  const [replay, setReplay] = useState<Solve | null>(null);
  const engine = useRef<TimerEngine | null>(null);
  const bluetooth = useRef(new BluetoothCube());
  const writes = useRef(Promise.resolve());
  const pending = useRef(0);
  const failedSaves = useRef(new Set<string>());
  const generation = useRef(0);
  const preparing = useRef(false);
  const queued = useRef<{ event: SmartCubeEvent; hostTime: number }[]>([]);
  const mounted = useRef(true);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const record = (solve: Solve) => {
    const copy = structuredClone(solve);
    setHistory(items => [copy, ...items.filter(item => item.id !== copy.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    pending.current++;
    setStorage('Saving locally...');
    writes.current = writes.current.then(() => saveSolves([copy])).then(() => {
      pending.current--;
      failedSaves.current.delete(copy.id);
      if (pending.current === 0) setStorage(failedSaves.current.size ? 'Some solves not saved - export a backup now' : 'Saved locally');
    }).catch((failure: Error) => {
      pending.current--;
      failedSaves.current.add(copy.id);
      setStorage('Not saved - export a backup now');
      setError(`Local storage: ${errorText(failure)}`);
    });
  };

  useEffect(() => {
    mounted.current = true; console.info('[Timer Bluetooth] Initializing Timer', { browser: navigator.userAgent, bluetoothAvailable: !!navigator.bluetooth, secureContext: window.isSecureContext });
    void loadCube().then(async model => {
      let recovered: Solve[] = [];
      try {
        const existing = await readSolves();
        recovered = validateBackup(backupJSON(existing), model);
        if (existing.some(solve => solve.status === 'active')) await saveSolves(recovered);
        if (mounted.current) setStorage('Saved locally');
      } catch (failure) {
        if (mounted.current) {
          setStorage('Local history unavailable');
          setError(failure instanceof Error ? failure.message : 'Cannot load local history.');
        }
      }
      if (!mounted.current) return;
      engine.current = new TimerEngine(model, record, render);
      setHistory(recovered.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setCube(model); console.info('[Timer Bluetooth] Puzzle loaded; connection controls ready');
    }).catch((failure: Error) => { console.error('[Timer Bluetooth] Puzzle initialization failed', failure); setError(errorText(failure)); });
    const interval = setInterval(render, 30);
    const adapter = bluetooth.current;
    return () => { mounted.current = false; clearInterval(interval); void adapter.disconnect(); };
  }, []);

  async function prepareScramble() {
    const timer = engine.current; if (!timer || preparing.current || ['solving', 'disconnected', 'recovery'].includes(timer.phase)) return;
    const token = ++generation.current, initial = timer.facelets;
    preparing.current = true; setBusy(true); setStatus('Generating scramble and setup locally...');
    try {
      const [scramble, setup] = await Promise.all([generateScramble(), initial === SOLVED ? Promise.resolve([]) : timer.cube.solution(initial)]);
      if (token !== generation.current) return;
      if (timer.facelets !== initial || !['synchronizing', 'scrambling', 'ready', 'finished'].includes(timer.phase)) throw new Error('Cube changed during preparation. Resynchronize and try again.');
      timer.prepare(scramble, setup); setStatus('');
    } catch (failure) {
      if (token === generation.current) { queued.current = []; setStatus(''); timer.fail('Scramble preparation failed. Read the cube state to retry.', false); setError(failure instanceof Error ? failure.message : 'Scramble generation failed.'); }
    } finally {
      if (token === generation.current) {
        preparing.current = false; setBusy(false); queued.current.splice(0).forEach(({ event, hostTime }) => receive(event, hostTime));
      }
    }
  }

  function cancelPreparation() { generation.current++; preparing.current = false; queued.current = []; setBusy(false); setStatus(''); }

  function receive(event: SmartCubeEvent, hostTime = performance.now()) {
    const timer = engine.current; if (!timer || (event.type === 'FACELETS' && event.source === 'moves')) return;
    if (preparing.current && (event.type === 'MOVE' || event.type === 'FACELETS')) { queued.current.push({ event, hostTime }); return; }
    try {
      if (event.type === 'MOVE') {
        timer.session = sessionRef.current.trim() || 'Default';
        timer.turn({ move: event.move, hostTime, localTimestamp: event.localTimestamp, cubeTimestamp: event.cubeTimestamp, serial: event.serial });
        if (timer.phase === 'finished') void prepareScramble();
      } else if (event.type === 'FACELETS') {
        const synchronizing = timer.phase === 'synchronizing';
        timer.snapshot(event.facelets, event.serial);
        if (synchronizing) void prepareScramble();
      } else if (event.type === 'BATTERY') setBattery(event.batteryLevel);
      else if (event.type === 'GYRO') timer.gyro(event.quaternion, hostTime);
      else if (event.type === 'DISCONNECT') {
        cancelPreparation();
        setBattery(null);
        timer.disconnect();
        void bluetooth.current.disconnect().catch((failure: Error) => setError(errorText(failure)));
      }
    } catch (failure) {
      console.error('[Timer Bluetooth] Timer rejected a cube event', { event, phase: timer.phase }, failure); timer.fail(failure instanceof Error ? failure.message : 'Invalid cube event.');
    }
  }

  function connect() {
    console.info('[Timer Bluetooth] Connect requested', { mac: mac.trim() || null, puzzleReady: !!cube, busy, connecting, connected: !!connected, bluetoothAvailable: !!navigator.bluetooth, secureContext: window.isSecureContext, userActivation: navigator.userActivation?.isActive }); if (!canConnect) { console.warn('[Timer Bluetooth] Connection blocked: check the flags above'); return; }
    setError(''); setConnecting(true); setDemo(false);
    void bluetooth.current.connect(mac, receive, connection => {
      engine.current?.connect(connection.deviceName); if (connection.deviceMAC) setMac(connection.deviceMAC);
    }, setStatus).then(() => { console.info('[Timer Bluetooth] Timer connected successfully'); setStatus(''); }).catch((failure: Error) => {
      console.error('[Timer Bluetooth] Connection/setup failed', failure); setError(errorText(failure)); setStatus('');
      if (!bluetooth.current.connection) engine.current?.disconnect();
    }).finally(() => setConnecting(false));
  }

  async function disconnect() {
    cancelPreparation();
    await bluetooth.current.disconnect().catch((failure: Error) => setError(errorText(failure)));
    engine.current?.disconnect(); setDemo(false); setBattery(null);
  }

  function calibrate() {
    const timer = engine.current; if (!timer) return; setError('');
    try { timer.synchronize(SOLVED); void prepareScramble(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Calibration failed.'); }
  }

  function startDemo() { engine.current?.connect('Simulated 3x3'); setDemo(true); calibrate(); }
  function changePrecision(value: 2 | 3) { setPrecision(value); try { localStorage.setItem('timer-time-precision', String(value)); } catch { setError('Time precision changed, but this browser could not save the preference.'); } }

  async function resynchronize() {
    const timer = engine.current; if (!timer) return;
    timer.interrupt('Manual resynchronization.');
    timer.phase = 'synchronizing'; timer.message = 'Requesting a fresh physical cube state...'; render();
    if (demo) { timer.synchronize(timer.facelets); await prepareScramble(); }
    else await bluetooth.current.refresh().catch((failure: Error) => setError(errorText(failure)));
  }

  async function importBackup(file?: File) {
    if (!file || !cube) return;
    try {
      if (file.size > 10_000_000) throw new Error('Backup exceeds the 10 MB import limit.');
      const solves = validateBackup(await file.text(), cube);
      await writes.current;
      await saveSolves(solves);
      setHistory((await readSolves()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setStorage('Saved locally'); setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Import failed.'); }
  }

  function exportHistory(format: 'json' | 'csv') {
    if (!cube) return;
    const url = URL.createObjectURL(new Blob([format === 'csv' ? cubeastCSV(history, cube) : backupJSON(history)], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `timer-${new Date().toISOString().slice(0, 10)}.${format}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const timer = engine.current, solve = timer?.active ?? timer?.result, elapsed = timer?.elapsed(performance.now()) ?? 0;
  const message = status || timer?.message || 'Loading local puzzle tools...';
  const { filtered, statistics } = useMemo(() => {
    const filtered = history.filter(solve => solve.session === session && solve.status !== 'active');
    return { filtered, statistics: sessionStats(filtered) };
  }, [history, session]);
  const setupCount = timer ? timer.instructions.length - timer.scramble.trim().split(/\s+/).length : 0;
  const connected = timer && timer.phase !== 'disconnected';
  const canConnect = !!cube && !busy && !connecting && !connected && !!navigator.bluetooth && window.isSecureContext;
  const simulate = (move: string) => receive({ type: 'MOVE', timestamp: performance.now(), move, face: 'URFDLB'.indexOf(move[0]), direction: move.endsWith("'") ? 1 : 0, localTimestamp: performance.now(), cubeTimestamp: null });
  return <main className="container py-4">
    <header className="d-flex justify-content-between align-items-center flex-wrap gap-3 mb-4">
      <div><h1>Timer<span className="brand-dot">.</span></h1><p className="text-secondary mb-0">Smart cube timing. Entirely in your browser.</p></div>
      <div className="d-flex align-items-center gap-2 flex-wrap">
        <details><summary className="btn btn-outline-secondary">Options</summary>
          <label className="mt-2">Time precision<select aria-label="Time precision" className="form-select" value={precision} onChange={event => changePrecision(event.target.value === '3' ? 3 : 2)}><option value="2">Hundredths (0.00)</option><option value="3">Thousandths (0.000)</option></select></label></details>
        {battery !== null && <span className="badge text-bg-secondary">{battery}% battery</span>}
        {connected ? <button className="btn btn-outline-secondary" onClick={() => void disconnect()}>Disconnect</button> :
          <><button className="btn btn-primary" disabled={!canConnect} onClick={connect}>{connecting ? 'Connecting...' : 'Connect cube'}</button>
          <button className="btn btn-outline-secondary" disabled={!cube || busy || connecting} onClick={startDemo}>Try simulated cube</button></>}
      </div>
    </header>
    {(!navigator.bluetooth || !window.isSecureContext) && <p className="alert alert-info">Bluetooth needs a supported browser and HTTPS or localhost. Try Chrome/Edge on Windows, or use the simulated cube.</p>}
    {error && <div className="alert alert-danger d-flex justify-content-between" role="alert">{error}<button className="btn-close" aria-label="Dismiss error" onClick={() => setError('')} /></div>}
    <div className="d-flex gap-3 flex-wrap align-items-end mb-3">
      <label>Session<input className="form-control" maxLength={100} value={session} disabled={timer?.phase === 'solving'} onChange={event => setSession(event.target.value)} /></label>
      {!connected && <><form onSubmit={event => { event.preventDefault(); connect(); }}><label>Bluetooth MAC (only if needed)<input className="form-control" placeholder="AA:BB:CC:DD:EE:FF" value={mac} disabled={connecting} onChange={event => setMac(event.target.value)} /></label></form><a href="help/mac-address.html" target="_blank" rel="noopener noreferrer">Find my cube's MAC address</a></>}
      <span className="text-secondary small">{storage}</span>
    </div>
    <section className="panel">
      <h2>Scramble</h2>
      <div className="scramble" aria-label="Scramble">{timer?.scramble ? timer.scramble.split(/\s+/).map((move, i) =>
        <span key={i} className={`move ${i + setupCount < timer.progress ? 'done' : i + setupCount === timer.progress ? 'current' : ''}`}>{move}</span>) : <span className="text-secondary">Connect a cube to generate a scramble.</span>}</div>
      {setupCount > 0 && timer && timer.progress < setupCount && <p className="mt-2">First solve the current cube: <strong>{timer.instructions.slice(timer.progress, setupCount).join(' ')}</strong></p>}
      {timer?.recovery.length ? <p className="text-warning mt-2">Correction: {timer.recovery.join(' ')}</p> : null}
    </section>
    <section className={`panel timer-panel mt-3 ${timer?.phase === 'ready' ? 'ready' : ''}`}>
      <div className="row g-3 align-items-center"><div className="col-lg-7">
          <span className="badge text-bg-secondary">{timer ? labels[timer.phase] : 'Loading puzzle...'}</span>
          <div className="timer-value" aria-label="Solve time">{formatTime(elapsed, precision)}</div>
          {!message.startsWith('Follow the highlighted') && <p role="status">{message}</p>}
          {timer?.active && <p>{timer.active.moves.length} reported moves recorded</p>}
          {connected && <div className="d-flex justify-content-center gap-2 flex-wrap">
            <button className="btn btn-outline-secondary" disabled={busy || timer.phase === 'solving'} onClick={() => void resynchronize()}>Read cube state</button>
            <button className="btn btn-outline-secondary" disabled={busy || timer.phase === 'solving'} onClick={calibrate}>Cube is physically solved - calibrate</button>
            {timer.phase === 'solving' && <button className="btn btn-outline-warning" onClick={() => timer.fail('Solve aborted by user.')}>Abort solve</button>}
          </div>}
      </div><div className="col-lg-5">
        {cube && timer && <CubeView cube={cube} facelets={timer.facelets} />}
      </div></div>
          {cube && solve && <SolveTimeline cube={cube} solve={solve} elapsed={elapsed} precision={precision} />}
          {demo && <div className="demo mt-4">
            <p className="text-warning">Simulated cube - not a physical Bluetooth connection</p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              {[...'URFDLB'].flatMap(face => [face, face + "'"]).map(move => <button key={move} className="btn btn-secondary" disabled={busy || !timer || ['synchronizing', 'recovery'].includes(timer.phase)} onClick={() => simulate(move)}>{move}</button>)}
            </div>
            <button className="btn btn-outline-secondary mt-2" disabled={busy || timer?.phase !== 'scrambling'} onClick={() => { if (timer?.nextMove) simulate(timer.nextMove); }}>Perform guided move</button>
            <button className="btn btn-outline-secondary mt-2 ms-2" disabled={busy || !timer || timer.phase !== 'ready'} onClick={() => {
              if (timer?.phase !== 'ready') return;
              const token = generation.current;
              timer.scramble.split(/\s+/).reverse().map(inverse).forEach((move, i) => setTimeout(() => { if (token === generation.current && demo && ['ready', 'solving'].includes(timer.phase)) simulate(move); }, i * 150));
            }}>Simulate solve</button>
          </div>}
    </section>
    <section className="panel mt-3">
      <h2>Current / records</h2>
      <p className="small text-secondary mt-3">Solves: {filtered.filter(solve => solve.status === 'complete').length} completed. Averages exclude incomplete attempts.</p>
      <div className="table-responsive">
        <table className="table table-sm" aria-label="Session statistics"><thead><tr><th scope="col">Metric</th><th scope="col">Current</th><th scope="col">Best</th></tr></thead>
          <tbody>{statistics.map(stat => <tr key={stat.name}><th scope="row">{stat.name}</th>
            <td>{stat.current === 'DNF' ? 'DNF' : stat.current === null ? '--' : formatTime(stat.current, precision)}</td><td>{stat.best === null ? '--' : formatTime(stat.best, precision)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>
    <section className="panel mt-3">
      <div className="d-flex justify-content-between flex-wrap gap-2"><h2>Session history</h2><div className="d-flex gap-2">
        <button className="btn btn-outline-secondary" onClick={() => exportHistory('csv')}>Export Cubeast CSV</button>
        <button className="btn btn-outline-secondary" onClick={() => exportHistory('json')}>Export JSON</button>
        <label className={`btn btn-outline-secondary mb-0 ${timer?.phase === 'solving' ? 'disabled' : ''}`}>Import JSON<input type="file" className="visually-hidden" accept=".json,application/json" disabled={timer?.phase === 'solving'} onChange={event => { void importBackup(event.target.files?.[0]); event.target.value = ''; }} /></label>
      </div></div>
      <div className="table-responsive"><table className="table align-middle" aria-label="Solve history">
        <thead><tr><th>Time</th><th>Date</th><th>Turns (QTM)</th><th>TPS</th><th>Recording</th><th>Replay</th></tr></thead>
        <tbody>{filtered.slice(0, 100).map(solve => <tr key={solve.id}>
          <td>{formatTime(solve.duration, precision)}s</td><td>{new Date(solve.createdAt).toLocaleString()}</td><td>{turns(solve)}</td>
          <td>{solve.duration > 0 ? (turns(solve) * 1000 / solve.duration).toFixed(2) : '--'}</td>
          <td title={solve.reason}>{solve.status}{solve.device === 'Simulated 3x3' ? ' (simulated)' : ''}</td>
          <td><button className="btn btn-sm btn-outline-secondary" onClick={() => setReplay(solve)}>Replay</button></td>
        </tr>)}</tbody>
      </table></div>
      {!filtered.length && <p className="text-secondary">No solves in this session yet. Your data stays on this device.</p>}
    </section>
    {cube && replay && <Replay key={replay.id} cube={cube} solve={replay} precision={precision} close={() => setReplay(null)} />}
    <footer className="text-secondary small mt-4">Browser-only. No API, backend, accounts, or uploads. Export backups before clearing browser data. Version 0.2.0.</footer>
  </main>;
}
