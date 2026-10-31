import 'fake-indexeddb/auto';
import { TimerEngine, type Solve } from '../engine';
import { Cube, loadCube, SOLVED } from '../puzzle';
import { average, backupJSON, readSolves, saveSolves, turns, validateBackup } from '../storage';

let cube: Cube;
beforeAll(async () => { cube = await loadCube(); });

function sample(): Solve {
  const timer = new TimerEngine(cube, () => {}, () => {});
  timer.connect('Test cube'); timer.synchronize(SOLVED); timer.prepare('R U2');
  ['R', 'U2', 'U2', "R'"].forEach((move, i) => timer.turn({ move, hostTime: i * 100, localTimestamp: i * 100, cubeTimestamp: null }));
  return timer.result!;
}

test('persists complete records and merges by id', async () => {
  const solve = sample();
  await saveSolves([solve]);
  await saveSolves([{ ...solve, session: 'Updated' }]);
  const items = await readSolves();
  expect(items.filter(item => item.id === solve.id)).toHaveLength(1);
  expect(items.find(item => item.id === solve.id)?.session).toBe('Updated');
});

test('JSON backup preserves every raw timing and turn', () => {
  const solve = sample();
  expect(validateBackup(backupJSON([solve]), cube)).toEqual([solve]);
  expect(turns(solve)).toBe(3);
});

test('recovers active recordings as incomplete', () => {
  const solve = { ...sample(), status: 'active' as const };
  expect(validateBackup(backupJSON([solve]), cube)[0].status).toBe('incomplete');
});

test.each(['null', '{}', '{"format":"timer-v1","solves":[null]}', '{"format":"timer-v1","solves":{}}'])('rejects malformed backup %s', json => {
  expect(() => validateBackup(json, cube)).toThrow();
});

test('rejects invalid timelines, false completion, duplicate ids and scramble mismatch', () => {
  const solve = sample();
  expect(() => validateBackup(backupJSON([{ ...solve, moves: [{ ...solve.moves[0], elapsed: -1 }] }]), cube)).toThrow();
  expect(() => validateBackup(backupJSON([{ ...solve, moves: solve.moves.slice(0, 1) }]), cube)).toThrow('does not end solved');
  expect(() => validateBackup(backupJSON([solve, solve]), cube)).toThrow();
  expect(() => validateBackup(backupJSON([{ ...solve, scramble: 'F' }]), cube)).toThrow('start');
});

test('averages trim high/low and exclude incomplete attempts', () => {
  const solve = sample();
  const items = [1, 2, 3, 4, 100].map(n => ({ ...solve, duration: n * 1000 }));
  expect(average([{ ...solve, status: 'incomplete' }, ...items], 5)).toBe(3000);
  expect(average(items, 12)).toBeNull();
});
