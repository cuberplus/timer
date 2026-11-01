import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { SmartCubeEvent } from 'smartcube-web-bluetooth';
import { BluetoothCube } from './bluetooth';
import { TimerEngine, solveTime, type Solve } from './engine';
import { generateScramble, inverse, loadCube, SOLVED, type Cube } from './puzzle';
import { backupJSON, cubeastCSV, formatTime, newPersonalBests, personalBestNotifications, readSolves, saveSolves, sessionStats, turns, validateBackup } from './storage';
import { CubeView } from './CubeView';
import { Replay } from './Replay';
import { SolveTimeline } from './SolveTimeline';
import { useScreenWakeLock } from './useScreenWakeLock';

const errorText = (error: Error): string => error.message || 'The operation failed.';
const historyColumns = [
  { key: 'number', label: 'Solve number' },
  { key: 'duration', label: 'Time' },
  { key: 'turns', label: 'Turns' },
  { key: 'tps', label: 'TPS' },
] as const;
type HistoryColumn = typeof historyColumns[number]['key'];
type InstallPrompt = Event & { prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }> };
type HiddenVisuals = { timer: boolean; cube: boolean; progressBar: boolean };

function SolvePenalty({ solve }: { solve: Solve | null | undefined }) {
  if (solve?.status === 'incomplete') return <>{' '}<span className="badge text-bg-danger solve-penalty">DNF</span></>;
  if (solve?.status === 'complete' && solve.penalty === 2000) return <>{' '}<span className="badge text-bg-warning solve-penalty">+2</span></>;
  return null;
}

export default function App() {
  useScreenWakeLock();
  const [, render] = useReducer(n => n + 1, 0);
  const [cube, setCube] = useState<Cube | null>(null);
  const [history, setHistory] = useState<Solve[]>([]);
  const [celebrations, setCelebrations] = useState<{ id: string; records: { name: string; time: number }[] }[]>([]);
  const celebration = celebrations[0] ?? null;
  const [historySort, setHistorySort] = useState<{ column: HistoryColumn; direction: 'ascending' | 'descending' }>({ column: 'number', direction: 'descending' });
  const [error, setError] = useState('');
  const [storage, setStorage] = useState('Loading local history...');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [demo, setDemo] = useState(false);
  const [battery, setBattery] = useState<number | null>(null);
  const [mac, setMac] = useState(() => { try { return localStorage.getItem('timer-last-cube-mac') ?? ''; } catch { return ''; } });
  const [precision, setPrecision] = useState<2 | 3>(() => { try { return localStorage.getItem('timer-time-precision') === '3' ? 3 : 2; } catch { return 2; } });
  const [overTurnPenalty, setOverTurnPenalty] = useState(() => { try { return localStorage.getItem('timer-over-turn-penalty') !== 'false'; } catch { return true; } });
  const [hiddenVisuals, setHiddenVisuals] = useState<HiddenVisuals>(() => {
    try {
      const value = JSON.parse(localStorage.getItem('timer-hide-distracting-visuals') ?? 'false') as Partial<HiddenVisuals> | boolean | null;
      const hidden = typeof value === 'object' && value !== null ? value : {};
      return { timer: value === true || hidden.timer === true, cube: value === true || hidden.cube === true, progressBar: value === true || hidden.progressBar === true };
    } catch { return { timer: false, cube: false, progressBar: false }; }
  });
  const [session, setSession] = useState('Default');
  const [replay, setReplay] = useState<Solve | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(() => window.matchMedia?.('(display-mode: standalone)').matches ?? false);
  const [installError, setInstallError] = useState('');
  const engine = useRef<TimerEngine | null>(null);
  const historyRef = useRef<Solve[]>([]);
  const recordChecks = useRef(new Map<string, { solve: Solve; previous: Solve[]; timeout: ReturnType<typeof setTimeout> }>());
  const dailyRecords = useRef<{ date: string; records: string[] } | null>(null);
  const optionsDialog = useRef<HTMLDialogElement>(null);
  const bluetooth = useRef(new BluetoothCube());
  const writes = useRef(Promise.resolve());
  const pending = useRef(0);
  const failedSaves = useRef(new Set<string>());
  const generation = useRef(0);
  const preparing = useRef(false);
  const resynchronizing = useRef(false);
  const queued = useRef<{ event: SmartCubeEvent; hostTime: number }[]>([]);
  const mounted = useRef(true);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const overTurnPenaltyRef = useRef(overTurnPenalty);
  overTurnPenaltyRef.current = overTurnPenalty;

  useEffect(() => {
    if (installed) return;
    const offerInstall = (event: Event) => {
      if (!('prompt' in event) || typeof event.prompt !== 'function') return;
      event.preventDefault(); setInstallPrompt(event as InstallPrompt); setInstallError('');
    };
    const didInstall = () => { setInstallPrompt(null); setInstalled(true); };
    window.addEventListener('beforeinstallprompt', offerInstall);
    window.addEventListener('appinstalled', didInstall);
    return () => {
      window.removeEventListener('beforeinstallprompt', offerInstall);
      window.removeEventListener('appinstalled', didInstall);
    };
  }, [installed]);

  async function installApp() {
    if (!installPrompt) return;
    const offer = installPrompt; setInstallPrompt(null); setInstallError('');
    try { await offer.prompt(); }
    catch { setInstallError('Installation could not start. Try the Install app option in your browser menu.'); }
  }

  function updateHistory(items: Solve[]) { historyRef.current = items; setHistory(items); }

  function notificationRecords(records: ReturnType<typeof newPersonalBests>) {
    const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const shown = new Set<string>(dailyRecords.current?.date === date ? dailyRecords.current.records : []);
    try {
      const saved = JSON.parse(localStorage.getItem('timer-pb-daily-records') ?? 'null') as typeof dailyRecords.current;
      if (saved?.date === date && Array.isArray(saved.records)) {
        saved.records.forEach(name => { if (name === 'Ao100' || name === 'Ao1000') shown.add(name); });
      }
    } catch { /* Keep the in-memory daily limit when storage is blocked. */ }
    const eligible = personalBestNotifications(records, shown);
    dailyRecords.current = { date, records: [...shown] };
    try { localStorage.setItem('timer-pb-daily-records', JSON.stringify(dailyRecords.current)); } catch { /* The daily limit still applies until this page is closed. */ }
    return eligible;
  }

  const record = (solve: Solve) => {
    const copy = structuredClone(solve);
    const previous = historyRef.current, check = recordChecks.current.get(copy.id);
    updateHistory([copy, ...previous.filter(item => item.id !== copy.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    if (copy.status === 'complete') {
      if (check) check.solve = copy;
      else {
        const timeout = setTimeout(() => {
          const candidate = recordChecks.current.get(copy.id);
          recordChecks.current.delete(copy.id);
          if (!candidate) return;
          const records = notificationRecords(newPersonalBests(candidate.previous, candidate.solve));
          if (records.length) setCelebrations(current => [...current, { id: copy.id, records }]);
        }, Math.max(0, 501 - (performance.now() - (copy.moves.at(-1)?.hostTime ?? performance.now()))));
        recordChecks.current.set(copy.id, { solve: copy, previous, timeout });
      }
    } else if (copy.status === 'incomplete') {
      if (check) { clearTimeout(check.timeout); recordChecks.current.delete(copy.id); }
      setCelebrations(current => current.filter(item => item.id !== copy.id));
    }
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
      engine.current.overTurnPenaltyEnabled = overTurnPenaltyRef.current;
      updateHistory(recovered.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setCube(model); console.info('[Timer Bluetooth] Puzzle loaded; connection controls ready');
    }).catch((failure: Error) => { console.error('[Timer Bluetooth] Puzzle initialization failed', failure); setError(errorText(failure)); });
    const interval = setInterval(render, 30);
    const adapter = bluetooth.current;
    const checks = recordChecks.current;
    return () => { mounted.current = false; clearInterval(interval); checks.forEach(check => clearTimeout(check.timeout)); checks.clear(); void adapter.disconnect(); };
  }, []);

  async function prepareScramble(recover = false) {
    const timer = engine.current;
    const allowed = ['synchronizing', 'scrambling', 'ready', 'finished', ...(recover ? ['recovery', 'recovering'] : [])];
    if (!timer || preparing.current || !allowed.includes(timer.phase)) return;
    const token = ++generation.current, initial = timer.facelets;
    preparing.current = true; setBusy(true); setStatus(recover ? 'Finding moves to return the cube to solved...' : 'Generating scramble and setup locally...');
    try {
      const [scramble, setup] = await Promise.all([recover ? Promise.resolve('') : generateScramble(), initial === SOLVED ? Promise.resolve([]) : timer.cube.solution(initial)]);
      if (token !== generation.current) return;
      if (timer.facelets !== initial || !allowed.includes(timer.phase)) throw new Error('Cube changed during preparation. Resynchronize and try again.');
      if (recover) timer.prepareRecovery(setup);
      else timer.prepare(scramble, setup);
      setStatus('');
    } catch (failure) {
      if (token === generation.current) { queued.current = []; setStatus(''); timer.fail('Scramble preparation failed. Read the cube state to retry.', false); setError(failure instanceof Error ? failure.message : 'Scramble generation failed.'); }
    } finally {
      if (token === generation.current) {
        preparing.current = false; setBusy(false); queued.current.splice(0).forEach(({ event, hostTime }) => receive(event, hostTime));
        if (recover && timer.phase === 'finished') void prepareScramble();
      }
    }
  }

  function cancelPreparation() { generation.current++; preparing.current = false; queued.current = []; setBusy(false); setStatus(''); }

  function receive(event: SmartCubeEvent, hostTime = performance.now()) {
    const timer = engine.current; if (!timer || (event.type === 'FACELETS' && event.source === 'moves')) return;
    const turn = event.type === 'MOVE' ? { move: event.move, hostTime, localTimestamp: event.localTimestamp, cubeTimestamp: event.cubeTimestamp, serial: event.serial } : null;
    try {
      if (preparing.current && (event.type === 'MOVE' || event.type === 'FACELETS')) {
        if (turn) timer.penalizeExtraTurn(turn);
        queued.current.push({ event, hostTime }); return;
      }
      if (turn) {
        timer.session = sessionRef.current.trim() || 'Default';
        timer.turn(turn);
        if (timer.phase === 'finished') void prepareScramble();
      } else if (event.type === 'FACELETS') {
        timer.snapshot(event.facelets, event.serial);
        if (timer.phase === 'synchronizing') void prepareScramble(timer.result?.status === 'incomplete');
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
    if (timer.phase === 'recovery' && timer.result?.status === 'incomplete' && !resynchronizing.current) void resynchronize();
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
  function changeOverTurnPenalty(value: boolean) {
    setOverTurnPenalty(value);
    if (engine.current) engine.current.overTurnPenaltyEnabled = value;
    try { localStorage.setItem('timer-over-turn-penalty', String(value)); }
    catch { setError('Penalty preference changed, but this browser could not save the preference.'); }
  }
  function changeHiddenVisuals(value: HiddenVisuals) { setHiddenVisuals(value); try { localStorage.setItem('timer-hide-distracting-visuals', JSON.stringify(value)); } catch { setError('Visual preference changed, but this browser could not save the preference.'); } }

  async function resynchronize() {
    const timer = engine.current; if (!timer || resynchronizing.current) return;
    resynchronizing.current = true;
    timer.interrupt('Manual resynchronization.');
    timer.phase = 'synchronizing'; timer.message = 'Requesting a fresh physical cube state...'; render();
    try {
      if (demo) { timer.synchronize(timer.facelets); await prepareScramble(timer.result?.status === 'incomplete'); }
      else await bluetooth.current.refresh();
    } catch (failure) {
      timer.fail('Cube state could not be read. Try Read cube state again.', false);
      setError(failure instanceof Error ? failure.message : 'Cube state could not be read.');
    } finally { resynchronizing.current = false; }
  }

  async function importBackup(file?: File) {
    if (!file || !cube) return;
    try {
      if (file.size > 10_000_000) throw new Error('Backup exceeds the 10 MB import limit.');
      const solves = validateBackup(await file.text(), cube);
      await writes.current;
      await saveSolves(solves);
      recordChecks.current.forEach(check => clearTimeout(check.timeout)); recordChecks.current.clear(); setCelebrations([]);
      updateHistory((await readSolves()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
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
  const historyRows = useMemo(() => {
    const rows = [...filtered].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)).map((solve, index) => {
      const count = turns(solve);
      return { solve, number: index + 1, duration: solveTime(solve), turns: count, tps: solve.duration > 0 ? count * 1000 / solve.duration : null };
    });
    return rows.sort((a, b) => {
      const left = a[historySort.column], right = b[historySort.column];
      if (left === null || right === null) return left === right ? a.number - b.number : left === null ? 1 : -1;
      return (left - right) * (historySort.direction === 'ascending' ? 1 : -1) || a.number - b.number;
    }).slice(0, 100);
  }, [filtered, historySort]);
  const recovering = timer?.phase === 'recovering';
  const setupCount = timer && !recovering ? timer.instructions.length - timer.scramble.trim().split(/\s+/).length : 0;
  const displayedMoves = recovering ? timer.instructions : timer?.scramble ? timer.scramble.split(/\s+/) : [];
  const correctionMoves = timer?.phase === 'scrambling' || recovering ? timer.recovery : [];
  const solving = timer?.phase === 'solving';
  const hideTimer = solving && hiddenVisuals.timer, hideCube = solving && hiddenVisuals.cube, hideProgressBar = solving && hiddenVisuals.progressBar;
  const allVisualsHidden = hiddenVisuals.timer && hiddenVisuals.cube && hiddenVisuals.progressBar;
  const someVisualsHidden = hiddenVisuals.timer || hiddenVisuals.cube || hiddenVisuals.progressBar;
  const currentMoveClass = timer?.isPartialTurn ? 'current partial' : 'current';
  const connected = timer && timer.phase !== 'disconnected';
  const canConnect = !!cube && !busy && !connecting && !connected && !!navigator.bluetooth && window.isSecureContext;
  const simulate = (move: string) => receive({ type: 'MOVE', timestamp: performance.now(), move, face: 'URFDLB'.indexOf(move[0]), direction: move.endsWith("'") ? 1 : 0, localTimestamp: performance.now(), cubeTimestamp: null });
  return <main className="container py-4">
    <header className="d-flex justify-content-between align-items-center flex-wrap gap-3 mb-4">
      <h1>CuberPlus - Timer</h1>
      <div className="d-flex align-items-center gap-2 flex-wrap">
        <button className="btn btn-outline-secondary" onClick={() => optionsDialog.current?.showModal()}>Options</button>
        {connected ? <button className="btn btn-outline-secondary" onClick={() => void disconnect()}>Disconnect</button> :
          <><button className="btn btn-primary" disabled={!canConnect} onClick={connect}>{connecting ? 'Connecting...' : 'Connect cube'}</button>
          <button hidden className="btn btn-outline-secondary" disabled={!cube || busy || connecting} onClick={startDemo}>Try simulated cube</button></>}
        {battery !== null && <span className="badge text-bg-secondary">{battery}% battery</span>}
      </div>
    </header>
    <dialog ref={optionsDialog} className="panel options-dialog" aria-labelledby="options-title">
      <div className="d-flex justify-content-between align-items-center mb-4">
        <h2 id="options-title" className="mb-0">Options</h2>
        <button className="btn-close btn-close-white" aria-label="Close options" onClick={() => optionsDialog.current?.close()} />
      </div>
      <label className="d-block mb-3">Session<input className="form-control mt-2" maxLength={100} value={session} disabled={timer?.phase === 'solving'} onChange={event => setSession(event.target.value)} /></label>
      <label className="d-block">Time precision<select aria-label="Time precision" className="form-select mt-2" value={precision} onChange={event => changePrecision(event.target.value === '3' ? 3 : 2)}><option value="2">Hundredths (0.00)</option><option value="3">Thousandths (0.000)</option></select></label>
      <label className="form-check mt-3"><input type="checkbox" className="form-check-input" checked={overTurnPenalty} aria-describedby="over-turn-penalty-help" onChange={event => changeOverTurnPenalty(event.target.checked)} /><span className="form-check-label">Extra-turn +2 penalty</span></label>
      <p id="over-turn-penalty-help" className="small text-secondary mt-2 mb-0">Apply +2 for an extra turn within 0.5 seconds after finishing.</p>
      <details className="mt-3">
        <summary className="visuals-summary d-flex align-items-center gap-2">
          <input type="checkbox" className="form-check-input m-0" aria-labelledby="hide-visuals-title" aria-describedby="hide-visuals-help" checked={allVisualsHidden} ref={element => { if (element) element.indeterminate = someVisualsHidden && !allVisualsHidden; }} onClick={event => event.stopPropagation()} onChange={event => changeHiddenVisuals({ timer: event.target.checked, cube: event.target.checked, progressBar: event.target.checked })} />
          <span id="hide-visuals-title">Hide distracting visuals</span>
        </summary>
        <fieldset className="mt-3 ms-3" aria-describedby="hide-visuals-help">
          <legend className="visually-hidden">Visuals hidden while solving</legend>
          <label className="form-check"><input type="checkbox" className="form-check-input" checked={hiddenVisuals.timer} onChange={event => changeHiddenVisuals({ ...hiddenVisuals, timer: event.target.checked })} /><span className="form-check-label">Timer</span></label>
          <label className="form-check"><input type="checkbox" className="form-check-input" checked={hiddenVisuals.cube} onChange={event => changeHiddenVisuals({ ...hiddenVisuals, cube: event.target.checked })} /><span className="form-check-label">Cube</span></label>
          <label className="form-check"><input type="checkbox" className="form-check-input" checked={hiddenVisuals.progressBar} onChange={event => changeHiddenVisuals({ ...hiddenVisuals, progressBar: event.target.checked })} /><span className="form-check-label">Progress bar</span></label>
          <p id="hide-visuals-help" className="small text-secondary mt-2 mb-0">Choose which visuals to hide while solving.</p>
        </fieldset>
      </details>
      {!installed && <div className="mt-4">
        <button className="btn btn-outline-secondary" disabled={!installPrompt} aria-describedby="install-help" onClick={() => void installApp()}>Install app</button>
        <p id="install-help" className="small text-secondary mt-2 mb-0">{installPrompt ? 'Add CuberPlus Timer to your home screen or apps.' : 'Installation becomes available when your browser offers it. You can also check your browser menu for Install app.'}</p>
        {installError && <p role="alert" className="text-warning mt-2 mb-0">{installError}</p>}
      </div>}
      {!connected && <div className="mt-4">
        <form onSubmit={event => { event.preventDefault(); if (canConnect) { optionsDialog.current?.close(); connect(); } }}><label className="d-block">Bluetooth MAC (only if needed)<input className="form-control mt-2" placeholder="AA:BB:CC:DD:EE:FF" value={mac} disabled={connecting} onChange={event => setMac(event.target.value)} /></label></form>
        <a className="d-inline-block mt-2" href="help/mac-address.html" target="_blank" rel="noopener noreferrer">Find my cube's MAC address</a>
      </div>}
      {(error.startsWith('Time precision changed') || error.startsWith('Visual preference changed') || error.startsWith('Penalty preference changed')) && <p role="alert" className="text-warning mt-3 mb-0">{error}</p>}
      <form method="dialog" className="text-end mt-4"><button className="btn btn-primary">Done</button></form>
    </dialog>
    {(!navigator.bluetooth || !window.isSecureContext) && <p className="alert alert-info">Bluetooth needs a supported browser and HTTPS or localhost. Try Chrome/Edge on Windows.</p>}
    {error && <div className="alert alert-danger d-flex justify-content-between" role="alert">{error}<button className="btn-close" aria-label="Dismiss error" onClick={() => setError('')} /></div>}
    {!['Saved locally', 'Saving locally...'].includes(storage) && <p className="text-secondary small mb-3">{storage}</p>}
    <section className={`panel timer-panel ${timer?.phase === 'ready' ? 'ready' : ''}`}>
      {recovering && <p className="small text-secondary mb-2">Return the cube to solved</p>}
      <div className={`scramble mb-3${solving ? ' scramble-solving' : ''}`} aria-label="Scramble">
        <div className="scramble-content" aria-hidden={solving}>{timer && displayedMoves.length ? <>
        {displayedMoves.map((move, i) => correctionMoves.length && !timer.completed[i + setupCount] ? null :
          <span key={i} className={`move ${timer.completed[i + setupCount] ? 'done' : i + setupCount === timer.progress ? currentMoveClass : timer.isPartialMove(i + setupCount) ? 'partial' : ''}`} title={timer.isPartialMove(i + setupCount) ? 'Partially complete' : undefined}>{move}</span>)}
        {!!correctionMoves.length && <span role="group" aria-label="Correction moves">{correctionMoves.map((move, i) =>
          <span key={i} className={`move correction ${i === 0 ? 'current' : ''}`}>{move}</span>)}</span>}
      </> : <span className="text-secondary">Connect a cube to generate a scramble.</span>}</div>
        {solving && <div className="scramble-placeholder text-secondary">
          <span role="status">Scrambles hidden while solving</span>
          <button className="btn btn-sm btn-outline-warning" onClick={() => { timer?.fail('Solve aborted by user.', true, 'solve aborted'); void prepareScramble(true); }}>Abort solve</button>
        </div>}
        <button className={`btn btn-sm btn-outline-secondary scramble-refresh${solving ? ' invisible' : ''}`} aria-label="New scramble" title="New scramble" aria-hidden={solving} disabled={busy || !timer || !['scrambling', 'ready', 'finished'].includes(timer.phase)} onClick={() => void prepareScramble()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M20 6v5h-5M20 11a8 8 0 1 0-2.3 6.7" />
          </svg>
        </button>
      </div>
      {setupCount > 0 && timer && timer.progress < setupCount && !correctionMoves.length && <p className="mt-2">First solve the current cube: <strong>{timer.instructions.slice(timer.progress, setupCount).map((move, i) =>
        <span key={i} className={`move ${timer.completed[timer.progress + i] ? 'done' : i === 0 ? currentMoveClass : timer.isPartialMove(timer.progress + i) ? 'partial' : ''}`} title={timer.isPartialMove(timer.progress + i) ? 'Partially complete' : undefined}>{move}</span>)}</strong></p>}
      <div className="row g-3 align-items-center"><div className={hideCube ? 'col-12' : 'col-lg-7'}>
      {hideTimer ? <div className="solving-indicator" role="status" aria-label="Solving">
        <span>Solving</span><span className="solving-dots" aria-hidden="true"><span>...</span></span>
      </div> : <>
          <div className="timer-display d-flex align-items-center justify-content-center gap-3">
            <div className="timer-value" aria-label="Solve time">{formatTime(timer?.active ? elapsed : solve ? solveTime(solve) : elapsed, precision)}</div>
            <SolvePenalty solve={solve} />
          </div>
          <div className="timer-details">
            {!(solve?.status === 'incomplete' && message === solve.reason) && !/^(?:Follow the highlighted|Wrong turn\.|Turn .+ once more to complete |Scramble complete\.)/.test(message) && <p className="small mb-0" role="status">{message}</p>}
          </div>
      </>}
      </div>{!hideCube && <div className="col-lg-5">
        {cube && timer && <CubeView cube={cube} facelets={timer.facelets} moves={timer.visualizationMoves} animateSeeks />}
      </div>}</div>
          {!hideProgressBar && cube && solve && <SolveTimeline cube={cube} solve={solve} elapsed={elapsed} precision={precision} />}
          {connected && <div className="d-flex justify-content-center gap-2 flex-wrap mt-3">
            <button className="btn btn-outline-secondary" disabled={busy || timer.phase === 'solving'} onClick={() => void resynchronize()}>Read cube state</button>
            <button className="btn btn-outline-secondary" disabled={busy || timer.phase === 'solving'} onClick={calibrate}>Cube is physically solved - calibrate</button>
          </div>}
          {demo && <div className="demo mt-4">
            <p className="text-warning">Simulated cube - not a physical Bluetooth connection</p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              {[...'URFDLB'].flatMap(face => [face, face + "'"]).map(move => <button key={move} className="btn btn-secondary" disabled={busy || !timer || ['synchronizing', 'recovery'].includes(timer.phase)} onClick={() => simulate(move)}>{move}</button>)}
            </div>
            <button className="btn btn-outline-secondary mt-2" disabled={busy || !timer || !['scrambling', 'recovering'].includes(timer.phase)} onClick={() => { if (timer?.nextMove) simulate(timer.nextMove); }}>Perform guided move</button>
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
        <thead><tr>{historyColumns.map(column => <th key={column.key} scope="col" aria-sort={historySort.column === column.key ? historySort.direction : undefined}>
          <button className="history-sort" onClick={() => setHistorySort(current => ({
            column: column.key, direction: current.column === column.key && current.direction === 'ascending' ? 'descending' : 'ascending',
          }))}>{column.label}</button>
        </th>)}<th scope="col">View</th></tr></thead>
        <tbody>{historyRows.map(({ solve, number, turns: count, tps }) => <tr key={solve.id}>
          <td>{number}</td><td>{formatTime(solveTime(solve), precision)}s<SolvePenalty solve={solve} /></td><td>{count}</td>
          <td>{tps === null ? '--' : tps.toFixed(2)}</td>
          <td><button className="btn btn-sm btn-outline-secondary" onClick={() => setReplay(solve)}>View</button></td>
        </tr>)}</tbody>
      </table></div>
      {!filtered.length && <p className="text-secondary">No solves in this session yet. Your data stays on this device.</p>}
    </section>
    {cube && replay && <Replay key={replay.id} cube={cube} solve={replay} precision={precision} close={() => setReplay(null)} />}
    {celebration && <div key={`pb-${celebration.id}`} className="pb-celebration" role="status" aria-label="Personal best">
      <svg width="52" height="64" viewBox="0 0 64 80" aria-hidden="true" focusable="false">
        <defs><pattern id="pb-disco-tiles" width="12" height="12" patternUnits="userSpaceOnUse">
          <path d="M0 0h12v12H0z" fill="#c8ddf5" /><path d="M0 0h6v6H0zM6 6h6v6H6z" fill="#7d8dba" />
          <path d="M0 6h6v6H0z" fill="#b695ef" /><path d="M0 0h12v12H0zM6 0v12M0 6h12" fill="none" stroke="#181f2d" strokeWidth="0.7" />
        </pattern></defs>
        <path d="M32 0v16" stroke="#c8ddf5" strokeWidth="2" />
        <g className="pb-disco-ball"><circle cx="32" cy="40" r="24" fill="url(#pb-disco-tiles)" stroke="#e8edf5" />
          <path d="M21 20c-7 12-7 28 0 40M43 20c7 12 7 28 0 40" fill="none" stroke="#e8edf5" opacity="0.6" /></g>
        <path className="pb-sparkles" d="M9 12v10M4 17h10M56 59v10M51 64h10" fill="none" stroke="#f5b942" strokeWidth="2" />
      </svg>
      <div><strong>{celebration.records.length === 1 ? 'New personal best!' : 'New personal bests!'}</strong>
        <div>{celebration.records.map(record => `${record.name}: ${formatTime(record.time, precision)}s`).join(' / ')}</div>
      </div>
      <button className="btn btn-sm btn-outline-light pb-dismiss" aria-label="Dismiss personal best"
        onClick={() => setCelebrations(current => current.filter(item => item.id !== celebration.id))}>Dismiss</button>
    </div>}
    <footer className="text-secondary small mt-4">Browser-only. No API, backend, accounts, or uploads. Export backups before clearing browser data. Version 0.2.3.</footer>
  </main>;
}
