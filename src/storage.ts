import type { Solve } from './engine';
import { Cube, isMove, movesOf } from './puzzle';

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
    return solve.status === 'active' ? { ...solve, status: 'incomplete', reason: 'Interrupted attempt recovered from backup.' } : solve;
  });
}

export const backupJSON = (solves: Solve[]): string => JSON.stringify({ format: 'timer-v1', solves }, null, 2);
export const average = (solves: Solve[], count: number): number | null => {
  const values = solves.filter(s => s.status === 'complete').slice(0, count).map(s => s.duration).sort((a, b) => a - b);
  return values.length === count ? values.slice(1, -1).reduce((a, b) => a + b, 0) / (count - 2) : null;
};
export const turns = (solve: Solve): number => solve.moves.reduce((n, move) => n + (move.move.includes('2') ? 2 : 1), 0);
export const formatTime = (milliseconds: number): string => (milliseconds / 1000).toFixed(2);
