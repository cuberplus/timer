import { getDnfReason, solveTime, type Solve } from './engine';
import { Cube, isMove, movesOf } from './puzzle';
import { analyzeCFOP, CFOP_STEPS, cfopFrame, cfopTiming, elapsedAt } from './cfop';

const database = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open('smart-cube-timer', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('solves', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('Cannot open local storage.'));
});

export async function saveSolves(solves: Solve[]): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('solves', 'readwrite');
      solves.forEach(solve => tx.objectStore('solves').put(solve));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Local save failed.'));
      tx.onerror = () => reject(tx.error ?? new Error('Local save failed.'));
    });
  } finally { db.close(); }
}

export async function readSolves(): Promise<Solve[]> {
  const db = await database();
  try {
    return await new Promise<Solve[]>((resolve, reject) => {
      const tx = db.transaction('solves', 'readonly');
      const request = tx.objectStore('solves').getAll();
      tx.oncomplete = () => resolve(request.result as Solve[]);
      tx.onabort = () => reject(tx.error ?? new Error('Cannot read local solves.'));
    });
  } finally { db.close(); }
}

const finite = (n: number): boolean => typeof n === 'number' && Number.isFinite(n);
const text = (s: string, max = 1000): boolean => typeof s === 'string' && s.length <= max;

export function validateBackup(json: string, cube: Cube): Solve[] {
  if (json.length > 10_000_000) throw new Error('Backup exceeds the 10 MB import limit.');
  const backup = JSON.parse(json) as { format: string; solves: Solve[] };
  if (!backup || typeof backup !== 'object' || backup.format !== 'timer-v1' || !Array.isArray(backup.solves)) throw new Error('Not a Timer JSON backup.');
  const ids = new Set<string>();
  return backup.solves.map(solve => {
    if (!solve || typeof solve !== 'object' || solve.version !== 1 ||
        !text(solve.id, 100) || !solve.id || ids.has(solve.id) || !text(solve.session, 100) ||
        !text(solve.device, 200) || !text(solve.createdAt, 100) || !Number.isFinite(Date.parse(solve.createdAt)) ||
        !text(solve.scramble) || !movesOf(solve.scramble).length || movesOf(solve.scramble).some(move => !isMove(move)) ||
        !text(solve.startFacelets, 54) || !text(solve.reason) ||
        !finite(solve.duration) || solve.duration < 0 ||
        (solve.inspection !== undefined && (!finite(solve.inspection) || solve.inspection < 0)) ||
        (solve.penalty !== undefined && solve.penalty !== 2000) ||
        (solve.penaltyReason !== undefined && (solve.penaltyReason !== 'over-turn' || solve.penalty !== 2000)) ||
        (solve.dnfReason !== undefined && (!['solve interrupted', 'solve aborted'].includes(solve.dnfReason) || solve.status !== 'incomplete')) ||
        !['active', 'complete', 'incomplete'].includes(solve.status) ||
        !['host', 'device-fit'].includes(solve.timingBasis) ||
        !Array.isArray(solve.moves) || !Array.isArray(solve.orientations)) throw new Error('Invalid solve record in backup.');
    ids.add(solve.id);
    const pattern = cube.parse(solve.startFacelets);
    if (!cube.equals(pattern, cube.solved().applyAlg(solve.scramble))) throw new Error('Solve start does not match its scramble.');
    solve.moves.forEach((move, i) => {
      if (!move || typeof move !== 'object' || !text(move.move, 3) || !isMove(move.move) ||
          !finite(move.hostTime) || !finite(move.elapsed) || move.elapsed < 0 ||
          (move.localTimestamp !== null && !finite(move.localTimestamp)) ||
          (move.cubeTimestamp !== null && !finite(move.cubeTimestamp)) ||
          (move.serial !== undefined && (!Number.isInteger(move.serial) || move.serial < 0)) ||
          (i === 0 ? move.elapsed !== 0 : move.elapsed < solve.moves[i - 1].elapsed)) throw new Error('Invalid move timeline.');
    });
    solve.orientations.forEach(sample => {
      if (!sample || typeof sample !== 'object' || !finite(sample.elapsed) || sample.elapsed < 0 ||
          !sample.quaternion || !['x', 'y', 'z', 'w'].every(axis => finite(sample.quaternion[axis as keyof typeof sample.quaternion]))) throw new Error('Invalid orientation sample.');
    });
    if (solve.status === 'complete' && (!solve.moves.length || !cube.isSolved(pattern.applyAlg(solve.moves.map(move => move.move).join(' '))))) throw new Error('Completed solve does not end solved.');
    const restored: Solve = solve.status === 'active' ? { ...solve, status: 'incomplete', reason: 'Interrupted attempt recovered from backup.', dnfReason: 'solve interrupted' } : { ...solve };
    if (restored.penalty === 2000) restored.penaltyReason ??= 'over-turn';
    if (restored.status === 'incomplete') restored.dnfReason = getDnfReason(restored);
    return restored;
  });
}

export const backupJSON = (solves: Solve[]): string => JSON.stringify({ format: 'timer-v1', solves }, null, 2);
function rollingAverages(values: number[], count: number): { current: number | null; best: number | null } {
  if (values.length < count || count < 3) return { current: null, best: null };
  const trim = Math.ceil(count / 20), kept = count - trim * 2, sorted = values.slice(0, count).sort((a, b) => a - b);
  let sum = sorted.slice(trim, -trim).reduce((a, b) => a + b, 0);
  const current = sum / kept; let best = current;
  const position = (value: number) => {
    let low = 0, high = sorted.length;
    while (low < high) { const mid = (low + high) >>> 1; if (sorted[mid] < value) low = mid + 1; else high = mid; }
    return low;
  };
  for (let i = count; i < values.length; i++) {
    // Account for values crossing the trimmed boundaries as the window slides.
    const outgoing = position(values[i - count]);
    sum -= outgoing < trim ? sorted[trim] : outgoing >= count - trim ? sorted[count - trim - 1] : sorted[outgoing];
    sorted.splice(outgoing, 1);
    const incoming = position(values[i]);
    sum += incoming < trim ? sorted[trim - 1] : incoming >= count - trim ? sorted[count - trim - 1] : values[i];
    sorted.splice(incoming, 0, values[i]); best = Math.min(best, sum / kept);
  }
  return { current, best };
}
export const average = (solves: Solve[], count: number): number | null => rollingAverages(solves.filter(s => s.status === 'complete').slice(0, count).map(solveTime), count).current;
export function sessionStats(solves: Solve[]): { name: string; current: number | 'DNF' | null; best: number | null }[] {
  const values = solves.filter(s => s.status === 'complete').map(solveTime), latest = solves.find(s => s.status !== 'active');
  return [
    { name: 'Single', current: !latest ? null : latest.status === 'complete' ? solveTime(latest) : 'DNF', best: values.length ? values.reduce((best, value) => Math.min(best, value), Infinity) : null },
    ...[5, 12, 100, 1000].map(count => ({ name: `Ao${count}`, ...rollingAverages(values, count) })),
  ];
}
export function newPersonalBests(previous: Solve[], solve: Solve): { name: string; time: number }[] {
  if (solve.status !== 'complete') return [];
  const session = previous.filter(item => item.session === solve.session && item.id !== solve.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const before = sessionStats(session), after = sessionStats([solve, ...session]);
  return after.flatMap((stat, i) => stat.best !== null && (before[i].best === null || stat.best < before[i].best!)
    ? [{ name: stat.name, time: stat.best }] : []);
}
export function personalBestNotifications(records: ReturnType<typeof newPersonalBests>, shown: Set<string>): ReturnType<typeof newPersonalBests> {
  return records.filter(record => {
    if (record.name !== 'Ao100' && record.name !== 'Ao1000') return true;
    if (shown.has(record.name)) return false;
    shown.add(record.name);
    return true;
  });
}
export const turns = (solve: Solve): number => solve.moves.reduce((n, move) => n + (move.move.includes('2') ? 2 : 1), 0);
export const formatTime = (milliseconds: number, precision: 2 | 3 = 2): string => (milliseconds / 1000).toFixed(precision);

const cubeastColumns = 'id,date,dnf,time,solving_method,device_name,device_model,device_color_scheme,user,one_turn_away_two_second_penalty,inspection_two_second_penalty,inspection_time,timer_time,missing_turn,solution,timer,description,session_name,session_ruleset,scramble,scramble_provider,ruleset,share_views,share_likes,share_comments,analysis_version,solution_rotation,pickup_time,putdown_time,solving_time,slice_turns,face_turns,quarter_turns,turns_per_second,total_recognition_time,total_execution_time,turns_after_solution,steps_skipped'.split(',').concat(
  Array.from({ length: 9 }, (_, i) => 'name,moves,recorded_moves,skipped,has_turns,time,recognition_time,execution_time,cumulative_time,slice_turns,face_turns,quarter_turns,turns_per_second'.split(',').map(field => `step_${i}_${field}`)).flat(),
  Array.from({ length: 9 }, (_, i) => `step_${i}_case`),
);
const csvCell = (value: string | number | boolean): string => /[",\r\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
export function cubeastCSV(solves: Solve[], cube: Cube): string {
  const rows = solves.filter(solve => solve.status !== 'active').map(solve => {
    const duration = solve.status === 'complete' ? Math.round(solve.duration) : '';
    const values: Record<string, string | number | boolean> = {
      id: solve.id, date: new Date(solve.createdAt).toISOString().slice(0, 19).replace('T', ' ') + ' UTC',
      dnf: solve.status !== 'complete', time: solve.status === 'complete' ? Math.round(solveTime(solve)) : '', timer_time: duration, solving_time: duration,
      one_turn_away_two_second_penalty: solve.penalty === 2000,
      inspection_time: solve.inspection === undefined ? '' : Math.round(solve.inspection),
      device_name: solve.device, session_name: solve.session, scramble: solve.scramble, scramble_provider: 'random_state',
      solution: solve.moves.map((move, i) => `${move.move}[${Math.round(elapsedAt(solve, i + 1))}]`).join(' '),
      timer: 'cube', solving_method: 'CFOP', description: solve.reason, slice_turns: solve.moves.length, face_turns: solve.moves.length,
      quarter_turns: turns(solve), turns_per_second: solve.duration > 0 ? (solve.moves.length * 1000 / solve.duration).toFixed(2) : '',
    };
    const analysis = analyzeCFOP(solve, cube), frame = analysis.cross === null ? (move: string) => move : cfopFrame(cube, analysis.cross);
    CFOP_STEPS.forEach((name, i) => {
      const start = analysis.ends[i - 1] ?? 0, end = analysis.ends[i];
      values[`step_${i}_name`] = name; if (end === undefined) return;
      const moves = solve.moves.slice(start, end), { end: cumulative, time, recognition, execution } = cfopTiming(solve, analysis.ends, i);
      const step: Record<string, string | number | boolean> = {
        moves: moves.map(move => frame(move.move)).join(' '), recorded_moves: moves.map((move, j) => `${frame(move.move)}[${Math.round(elapsedAt(solve, start + j + 1))}]`).join(' '),
        skipped: start === end, has_turns: moves.length > 0, time, cumulative_time: cumulative,
        recognition_time: recognition, execution_time: execution, slice_turns: moves.length, face_turns: moves.length,
        quarter_turns: turns({ ...solve, moves }), turns_per_second: time > 0 ? (moves.length * 1000 / time).toFixed(2) : '',
      };
      Object.entries(step).forEach(([field, value]) => { values[`step_${i}_${field}`] = value; });
    });
    values.steps_skipped = analysis.ends.filter((end, i) => end === (analysis.ends[i - 1] ?? 0)).length;
    values.total_recognition_time = analysis.ends.reduce((sum, _, i) => sum + Number(values[`step_${i}_recognition_time`]), 0);
    values.total_execution_time = analysis.ends.reduce((sum, _, i) => sum + Number(values[`step_${i}_execution_time`]), 0);
    return cubeastColumns.map(column => csvCell(values[column] ?? '')).join(',');
  });
  return [cubeastColumns.join(','), ...rows, ''].join('\r\n');
}
