import { jest } from '@jest/globals';
import { TimerEngine, finalizeTiming, type RecordedTurn, type Solve } from '../engine';
import { Cube, SOLVED, inverse, loadCube, movesOf, simplifyMoves } from '../puzzle';

let cube: Cube;
beforeAll(async () => { cube = await loadCube(); });

function create(scramble = 'R U2') {
  const records: Solve[] = [];
  const changed = jest.fn();
  const engine = new TimerEngine(cube, solve => records.push(structuredClone(solve)), changed);
  engine.connect('Test cube');
  engine.synchronize(SOLVED);
  engine.prepare(scramble);
  let host = 100;
  const turn = (move: string, serial?: number) => engine.turn({
    move, hostTime: host += 100, localTimestamp: host, cubeTimestamp: null, serial,
  });
  return { engine, records, turn };
}

test('facelet conversion matches a known physical F R state', () => {
  const pattern = cube.solved().applyAlg('F R');
  expect(cube.facelets(pattern)).toBe('UUFUUFLLFUUURRRRRRFFRFFDFFDRRBDDBDDBLLDLLDLLDLBBUBBUBB');
  expect(cube.equals(cube.parse(cube.facelets(pattern)), pattern)).toBe(true);
});

test.each(['U', 'R', 'F', 'D', 'L', 'B', "R U R' U' F2 L B' D2"])('round trips the facelets for %s', alg => {
  const pattern = cube.solved().applyAlg(alg);
  expect(cube.equals(cube.parse(cube.facelets(pattern)), pattern)).toBe(true);
});

test('rejects impossible cube parity, orientation and unsupported sizes', () => {
  const flipped = SOLVED.split('');
  [flipped[7], flipped[19]] = [flipped[19], flipped[7]];
  expect(() => cube.parse(flipped.join(''))).toThrow('orientation');
  const swapped = SOLVED.split('');
  [swapped[19], swapped[10]] = [swapped[10], swapped[19]];
  expect(() => cube.parse(swapped.join(''))).toThrow('parity');
  expect(() => cube.parse('U'.repeat(24))).toThrow('3x3');
  expect(() => cube.parse('U'.repeat(54))).toThrow('3x3');
});

test('double turns complete from either pair of quarter turns; scramble completion only arms', () => {
  const { engine, records, turn } = create();
  turn('R');
  turn("U'");
  expect(engine.phase).toBe('scrambling');
  expect(engine.isPartialTurn).toBe(true);
  expect(engine.nextMove).toBe("U'");
  turn("U'");
  expect(engine.phase).toBe('ready');
  expect(engine.isPartialTurn).toBe(false);
  expect(records).toHaveLength(0);
  expect(engine.active).toBeNull();
});

test.each([
  ['U U', 'U2'],
  ['U U2', "U'"],
  ['U2 U2 R', 'R'],
  ['R L R', 'R2 L'],
  ["R L R' U", 'L U'],
  ["R L U U' R", 'R2 L'],
  ['F B F', 'F2 B'],
  ['D U D', 'D2 U'],
  ['R U R', 'R U R'],
])('normalizes %s to %s without changing the scramble state', (raw, expected) => {
  const { engine } = create(raw);
  expect(engine.scramble).toBe(expected);
  expect(engine.instructions).toEqual(movesOf(expected));
  expect(cube.equals(cube.solved().applyAlg(raw), cube.solved().applyAlg(expected))).toBe(true);
});

test('normalization cancels identity moves and does not allow an empty scramble', () => {
  expect(simplifyMoves(['U', "U'"])).toEqual([]);
  expect(simplifyMoves(['R', 'L', "R'", "L'"])).toEqual([]);
  const { engine } = create();
  expect(() => engine.prepare("R L R' L'")).toThrow('Invalid scramble');
  expect(() => engine.prepare('Rw R')).toThrow('Invalid scramble');
});

test.each([
  ['R', 'L'], ['U', 'D'], ['F', 'B'], ['R2', "L'"], ["R'", 'L2'], ['U2', 'D2'],
])('accepts %s %s in the opposite order without advancing the first highlight', (first, second) => {
  const { engine, records, turn } = create(`${first} ${second}`);
  turn(second);
  expect(engine.phase).toBe('scrambling');
  expect(engine.completed).toEqual([false, true]);
  expect(engine.progress).toBe(0);
  expect(engine.nextMove).toBe(first);
  expect(engine.recovery).toEqual([]);
  expect(engine.inspectionElapsed(10000)).toBe(0);
  expect(records).toHaveLength(0);
  turn(first);
  expect(engine.phase).toBe('ready');
  expect(engine.completed).toEqual([true, true]);
  expect(engine.progress).toBe(2);
  turn(inverse(second));
  turn(inverse(first));
  expect(engine.result?.status).toBe('complete');
  expect(engine.result?.inspection).toBe(100);
  expect(engine.result?.moves.map(move => move.move)).toEqual([inverse(second), inverse(first)]);
});

test('allows interleaved quarter turns for commuting doubles but waits for both full moves', () => {
  const { engine, turn } = create('R2 L2 U');
  turn("L'");
  expect(engine.completed).toEqual([false, false, false]);
  expect(engine.isPartialTurn).toBe(false);
  expect(engine.isPartialMove(1)).toBe(true);
  expect(engine.recovery).toEqual([]);
  turn('R');
  expect(engine.isPartialTurn).toBe(true);
  expect(engine.isPartialMove(1)).toBe(true);
  expect(engine.recovery).toEqual([]);
  turn("L'");
  expect(engine.completed).toEqual([false, true, false]);
  expect(engine.isPartialMove(1)).toBe(false);
  expect(engine.progress).toBe(0);
  expect(engine.nextMove).toBe('R');
  turn('R');
  expect(engine.completed).toEqual([true, true, false]);
  expect(engine.progress).toBe(2);
  expect(engine.nextMove).toBe('U');
  turn('U');
  expect(engine.phase).toBe('ready');
});

test('noncommuting later moves remain mistakes and corrections preserve a completed opposite-face step', () => {
  const { engine, turn } = create('F R L U');
  turn('F'); turn('L');
  expect(engine.completed).toEqual([true, false, true, false]);
  turn('U');
  expect(engine.recovery).toEqual(["U'"]);
  expect(engine.completed).toEqual([true, false, true, false]);
  turn("U'");
  expect(engine.recovery).toEqual([]);
  expect(engine.nextMove).toBe('R');
  turn("L'");
  expect(engine.completed).toEqual([true, false, false, false]);
  expect(engine.recovery).toEqual([]);
  turn('U'); turn('L');
  expect(engine.recovery).toEqual(["L'", "U'"]);
  expect(engine.completed).toEqual([true, false, false, false]);
  turn("L'"); turn("U'");
  turn('L'); turn('R'); turn('U');
  expect(engine.phase).toBe('ready');
});

test('returning to a non-solved checkpoint by a different sequence clears stale corrections', () => {
  const { engine, turn } = create('R B2');
  turn('R');
  const identity = Array.from({ length: 6 }, () => ['F', 'U', "F'", "U'"]).flat();
  identity.slice(0, -1).forEach(move => turn(move));
  expect(engine.recovery.length).toBeGreaterThan(0);
  turn(identity[identity.length - 1]);
  expect(engine.completed).toEqual([true, false]);
  expect(engine.progress).toBe(1);
  expect(engine.recovery).toEqual([]);
  expect(engine.nextMove).toBe('B2');
  turn('B2');
  expect(engine.phase).toBe('ready');
});

test('setup and scramble are normalized separately and commuting guidance cannot skip the setup boundary', () => {
  const { engine, turn } = create();
  engine.synchronize(cube.facelets(cube.solved().applyAlg("R2 L'")));
  engine.prepare('R L R', ["L", "R'", "R'"]);
  expect(engine.instructions).toEqual(['L', 'R2', 'R2', 'L']);
  turn('R2');
  expect(engine.completed).toEqual([false, true, false, false]);
  expect(engine.progress).toBe(0);
  turn('L');
  expect(engine.progress).toBe(2);
  expect(engine.completed).toEqual([true, true, false, false]);
  turn('L');
  expect(engine.completed).toEqual([true, true, false, true]);
  turn('R2');
  expect(engine.phase).toBe('ready');
});

test('visualization keeps every accepted setup, correction and solve turn and resets on synchronization', () => {
  const { engine, turn } = create('R');
  const moves = engine.visualizationMoves;
  turn('L', 1); turn("L'", 2); turn('R', 3); turn("R'", 4);
  expect(moves).toEqual(['L', "L'", 'R', "R'"]);
  turn("R'", 4); // Duplicate serial.
  turn('U', 6); // Counter gap.
  expect(moves).toEqual(['L', "L'", 'R', "R'"]);
  engine.synchronize(engine.facelets);
  expect(engine.visualizationMoves).toEqual([]);
  expect(engine.visualizationMoves).not.toBe(moves);
});

test('the first solve turn starts timing; the final solving turn is included', () => {
  const { engine, records, turn } = create();
  turn('R'); turn('U2');
  turn('U');
  expect(engine.phase).toBe('solving');
  expect(engine.active?.moves[0].elapsed).toBe(0);
  turn('U'); turn("R'");
  expect(engine.phase).toBe('finished');
  expect(engine.result?.moves.map(m => m.move)).toEqual(['U', 'U', "R'"]);
  expect(engine.result?.duration).toBe(200);
  expect(engine.result?.status).toBe('complete');
  expect(records[records.length - 1].moves).toHaveLength(3);
});

test('inspection starts at scramble completion, is separate from solve time, and each solve has a random GUID', () => {
  const { engine, records } = create('R');
  const turn = (move: string, hostTime: number) => engine.turn({ move, hostTime, localTimestamp: hostTime, cubeTimestamp: null });
  expect(engine.inspectionElapsed(10000)).toBe(0);
  turn('R', 0);
  expect(engine.inspectionElapsed(2500)).toBe(2500);
  turn("R'", 3000);
  const first = engine.result!;
  expect(first.inspection).toBe(3000);
  expect(first.duration).toBe(0);
  expect(first.moves[0].elapsed).toBe(0);
  expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(records[0].id).toBe(first.id);
  engine.prepare('R');
  expect(engine.inspectionElapsed(10000)).toBe(0);
  turn('R', 4000); turn("R'", 4500);
  expect(engine.result!.inspection).toBe(500);
  expect(engine.result!.id).not.toBe(first.id);
});

test('inspection is discarded on recovery and starts fresh after resynchronization', () => {
  const { engine } = create('R');
  const turn = (move: string, hostTime: number, serial: number) => engine.turn({ move, hostTime, serial, localTimestamp: hostTime, cubeTimestamp: null });
  turn('R', 100, 1);
  turn('U', 500, 3);
  expect(engine.phase).toBe('recovery');
  expect(engine.inspectionElapsed(1000)).toBe(0);
  engine.synchronize(SOLVED);
  engine.prepare('R');
  turn('R', 1200, 4); turn("R'", 1400, 5);
  expect(engine.result!.inspection).toBe(200);
});

test('mistakes guide back to the last checkpoint without starting timing', () => {
  const { engine, turn } = create();
  turn('L'); turn('F');
  expect(engine.recovery).toEqual(["F'", "L'"]);
  expect(engine.isPartialTurn).toBe(false);
  turn("F'");
  expect(engine.nextMove).toBe("L'");
  turn("L'");
  expect(engine.recovery).toEqual([]);
  expect(engine.progress).toBe(0);
  turn('R'); turn('U2');
  expect(engine.phase).toBe('ready');
});

test.each([false, true])('returning to solved restarts the original scramble after setup: %s', setup => {
  const { engine, records, turn } = create();
  if (setup) {
    engine.synchronize(cube.facelets(cube.solved().applyMove('F')));
    engine.prepare('R U2', ["F'"]);
    turn("F'");
  }
  turn('R'); turn('F');
  expect(engine.recovery).toEqual(["F'"]);
  turn("F'"); turn("R'");
  expect(engine.recovery).toEqual([]);
  expect(engine.progress).toBe(setup ? 1 : 0);
  expect(engine.nextMove).toBe('R');
  expect(engine.scramble).toBe('R U2');
  expect(engine.phase).toBe('scrambling');
  expect(records).toHaveLength(0);
  turn('R'); turn('U2');
  expect(engine.phase).toBe('ready');
});

test('solving by a different sequence clears outstanding corrections and scramble progress', () => {
  const { engine, turn } = create('R U F2');
  const moves = Array.from({ length: 6 }, () => ['R', 'U', "R'", "U'"]).flat();
  moves.slice(0, -1).forEach(move => turn(move));
  expect(engine.recovery.length).toBeGreaterThan(0);
  turn(moves[moves.length - 1]);
  expect(cube.isSolved(engine.pattern)).toBe(true);
  expect(engine.recovery).toEqual([]);
  expect(engine.progress).toBe(0);
  expect(engine.nextMove).toBe('R');
  expect(engine.phase).toBe('scrambling');
});

test('undoing a partial double turn returns to its checkpoint', () => {
  const { engine, turn } = create();
  turn('R'); turn('U');
  expect(engine.isPartialTurn).toBe(true);
  turn("U'");
  expect(engine.isPartialTurn).toBe(false);
  expect(engine.progress).toBe(1);
  expect(engine.nextMove).toBe('U2');
  expect(engine.recovery).toEqual([]);
});

test.each([
  ['U', 10, ['U2']],
  ["U'", 10, ['U2']],
  ['U', 3, ['U']],
  ['U', 4, []],
  ['U2', 3, ['U2']],
  ["R2'", 1, ['R2']],
  ['F', 2, ['F2']],
] as const)('simplifies undoing %s repeated %i times', (move, count, expected) => {
  const { engine, turn } = create(move[0] === 'R' ? 'F' : 'R');
  for (let i = 0; i < count; i++) turn(move);
  expect(engine.recovery).toEqual(expected);
  expect(cube.isSolved(engine.pattern.applyAlg(engine.recovery.join(' ')))).toBe(true);
  engine.recovery.forEach(move => turn(move));
  expect(engine.recovery).toEqual([]);
  expect(engine.progress).toBe(0);
  expect(engine.phase).toBe('scrambling');
});

test.each([false, true])('shortened corrections remain correct when double turns arrive as quarters: %s', split => {
  const { engine, turn } = create();
  turn('F');
  for (let i = 0; i < 10; i++) turn('U');
  expect(engine.recovery).toEqual(['U2', "F'"]);
  if (split) {
    turn('U');
    expect(engine.recovery).toEqual(['U', "F'"]);
    turn('U');
  } else turn('U2');
  expect(engine.recovery).toEqual(["F'"]);
  turn("F'");
  expect(engine.recovery).toEqual([]);
  expect(engine.nextMove).toBe('R');
  expect(cube.isSolved(engine.pattern)).toBe(true);
});

test('corrections cancel commuting moves without changing noncommuting move order', () => {
  const { engine, turn } = create();
  for (const move of ['F', 'U', 'D', 'U', "D'"]) turn(move);
  expect(engine.recovery).toEqual(['U2', "F'"]);
  engine.recovery.forEach(move => turn(move));
  for (const move of ['F', 'U', "F'", "U'"]) turn(move);
  expect(engine.recovery).toEqual(['U', 'F', "U'", "F'"]);
  expect(cube.isSolved(engine.pattern.applyAlg(engine.recovery.join(' ')))).toBe(true);
});

test('correction simplification never condenses recorded solve turns', () => {
  const { engine, turn } = create('R');
  turn('R');
  for (let i = 0; i < 10; i++) turn('F');
  turn('F2'); turn("R'");
  expect(engine.result?.status).toBe('complete');
  expect(engine.result?.moves.map(move => move.move)).toEqual([...Array<string>(10).fill('F'), 'F2', "R'"]);
});

test('same serial is ignored but repeated legitimate moves are recorded', () => {
  const { engine, turn } = create();
  turn('R', 10); turn('U2', 11);
  turn('U', 12); turn('U', 12); turn('U', 13); turn("R'", 14);
  expect(engine.result?.moves).toHaveLength(3);
  expect(engine.result?.status).toBe('complete');
});

test('counter gaps and disconnects retain incomplete attempts', () => {
  const first = create();
  first.turn('R', 1); first.turn('U2', 2); first.turn('U', 3); first.turn('U', 5);
  expect(first.engine.phase).toBe('recovery');
  expect(first.engine.result?.status).toBe('incomplete');
  expect(first.records[first.records.length - 1].reason).toContain('counter');
  const second = create();
  second.turn('R'); second.turn('U2'); second.turn('U'); second.engine.disconnect();
  expect(second.engine.phase).toBe('disconnected');
  expect(second.engine.result?.status).toBe('incomplete');
});

test('counter wrap and stale snapshots across the wrap preserve the move stream', () => {
  const { engine, turn } = create();
  turn('R', 254); turn('U2', 255); turn('U', 0);
  engine.snapshot(cube.facelets(cube.solved().applyAlg('R U2')), 255);
  expect(engine.phase).toBe('solving');
  turn('U', 1); turn("R'", 2);
  expect(engine.result?.status).toBe('complete');
  expect(engine.result?.moves.map(move => move.serial)).toEqual([0, 1, 2]);
});

test('stale snapshots do not roll back newer turns; mismatches invalidate recording', () => {
  const { engine, turn } = create();
  turn('R', 8);
  engine.snapshot(SOLVED, 7);
  expect(engine.phase).toBe('scrambling');
  engine.snapshot(SOLVED, 8);
  expect(engine.phase).toBe('recovery');
});

test('a post-solve authoritative mismatch invalidates a premature completion', () => {
  const { engine, turn } = create();
  turn('R'); turn('U2'); turn('U2'); turn("R'");
  engine.snapshot(cube.facelets(cube.solved().applyMove('R')));
  expect(engine.result?.status).toBe('incomplete');
});

test.each([0, 100, 499, 500, 501])('a first extra turn %s ms after completion applies +2 only within half a second', delay => {
  const { engine, records, turn } = create();
  turn('R', 1); turn('U2', 2); turn('U2', 3); turn("R'", 4);
  const original = structuredClone(engine.result!);
  engine.turn({ move: 'F', hostTime: 500 + delay, localTimestamp: null, cubeTimestamp: null, serial: 5 });
  expect(engine.result?.penalty).toBe(delay <= 500 ? 2000 : undefined);
  expect(engine.result?.penaltyReason).toBe(delay <= 500 ? 'over-turn' : undefined);
  expect(engine.result).toMatchObject({ id: original.id, duration: original.duration, status: 'complete', moves: original.moves });
  expect(cube.facelets(engine.pattern)).toBe(cube.facelets(cube.solved().applyMove('F')));
  const count = records.length;
  engine.turn({ move: 'F', hostTime: 510 + delay, localTimestamp: null, cubeTimestamp: null, serial: 6 });
  expect(records).toHaveLength(count);
  expect(records.at(-1)?.penalty).toBe(delay <= 500 ? 2000 : undefined);
});

test('duplicate completion packets do not count as extra turns, but the next genuine turn does', () => {
  const { engine, records, turn } = create();
  turn('R', 1); turn('U2', 2); turn('U2', 3); turn("R'", 4);
  turn("R'", 4);
  expect(engine.result?.penalty).toBeUndefined();
  expect(cube.isSolved(engine.pattern)).toBe(true);
  const count = records.length;
  turn('F', 5);
  expect(engine.result?.penalty).toBe(2000);
  expect(records).toHaveLength(count + 1);
});

test('the penalty window survives next-scramble preparation and never penalizes the next solve', () => {
  const { engine, turn } = create();
  turn('R'); turn('U2'); turn('U2'); turn("R'");
  const previous = engine.result!;
  engine.prepare('F L2');
  turn('F'); turn('L2');
  expect(previous.penalty).toBe(2000);
  turn('L2'); turn("F'");
  expect(engine.result?.id).not.toBe(previous.id);
  expect(engine.result?.penalty).toBeUndefined();
  expect(engine.result?.moves.map(move => move.move)).toEqual(['L2', "F'"]);
});

test('a post-solve counter gap invalidates the solve instead of assigning a penalty', () => {
  const { engine, turn } = create();
  turn('R', 1); turn('U2', 2); turn('U2', 3); turn("R'", 4);
  turn('F', 6);
  expect(engine.result?.status).toBe('incomplete');
  expect(engine.result?.penalty).toBeUndefined();
  expect(engine.result?.dnfReason).toBe('solve interrupted');
});

test('disabling extra-turn penalties consumes the window without retroactively penalizing when re-enabled', () => {
  const { engine, records, turn } = create();
  turn('R'); turn('U2'); turn('U2'); turn("R'");
  engine.overTurnPenaltyEnabled = false;
  const count = records.length;
  turn('F');
  engine.overTurnPenaltyEnabled = true;
  turn('F');
  expect(records).toHaveLength(count);
  expect(engine.result?.penalty).toBeUndefined();
  expect(engine.result?.penaltyReason).toBeUndefined();
});

test.each(['solve interrupted', 'solve aborted'] as const)('stores the DNF classification %s separately from diagnostic details', dnfReason => {
  const { engine, records, turn } = create();
  turn('R'); turn('U2'); turn('U');
  engine.fail('Diagnostic details.', true, dnfReason);
  expect(records.at(-1)).toMatchObject({ status: 'incomplete', reason: 'Diagnostic details.', dnfReason });
});

test.each([
  ['guided', ['U', "R'"]],
  ['alternative', ['U2', "U'", "R'"]],
] as const)('%s DNF recovery recognizes solved state without recording recovery turns', (_name, moves) => {
  const { engine, records, turn } = create();
  turn('R'); turn('U2'); turn('U');
  engine.fail('Solve aborted by user.', true, 'solve aborted');
  const dnf = structuredClone(engine.result!), writes = records.length;
  engine.prepareRecovery(['U', "R'"]);
  expect(engine.phase).toBe('recovering');
  expect(engine.scramble).toBe('');
  for (const move of moves) turn(move);
  expect(engine.phase).toBe('finished');
  expect(cube.isSolved(engine.pattern)).toBe(true);
  expect(engine.inspectionElapsed(10000)).toBe(0);
  expect(engine.active).toBeNull();
  expect(engine.result).toEqual(dnf);
  expect(records).toHaveLength(writes);
  engine.prepare('F L2');
  turn('F'); turn('L2'); turn('L2'); turn("F'");
  expect(engine.result?.status).toBe('complete');
  expect(engine.result?.id).not.toBe(dnf.id);
  expect(engine.result?.moves.map(move => move.move)).toEqual(['L2', "F'"]);
});

test('recovery retains partial-double highlighting, duplicate protection and correction guidance', () => {
  const { engine, turn } = create();
  turn('R', 1); turn('U2', 2); turn('F', 3);
  engine.fail('Aborted.', true, 'solve aborted');
  engine.prepareRecovery(["F'", 'U2', "R'"]);
  turn("F'", 4); turn('U', 5); turn('U', 5);
  expect(engine.isPartialMove(1)).toBe(true);
  expect(engine.progress).toBe(1);
  turn('L', 6);
  expect(engine.recovery.length).toBeGreaterThan(0);
  turn("L'", 7); turn('U', 8); turn("R'", 9);
  expect(engine.phase).toBe('finished');
  expect(engine.result?.moves.map(move => move.move)).toEqual(['F']);
});

test('fresh recovery snapshots replace stale state, while stale snapshots are ignored', () => {
  const { engine, turn } = create();
  turn('R', 1); turn('U2', 2); turn('U', 3);
  engine.fail('Aborted.', true, 'solve aborted');
  engine.prepareRecovery(['U', "R'"]);
  engine.snapshot(SOLVED, 2);
  expect(engine.phase).toBe('recovering');
  engine.snapshot(SOLVED, 4);
  expect(engine.phase).toBe('synchronizing');
  engine.prepareRecovery([]);
  expect(engine.phase).toBe('finished');
  expect(engine.result?.status).toBe('incomplete');
});

test('invalid recovery algorithms are rejected before changing guidance', () => {
  const { engine, turn } = create();
  expect(() => engine.prepareRecovery([])).toThrow('Cannot prepare recovery');
  turn('R'); turn('U2'); turn('U'); engine.fail('Aborted.');
  expect(() => engine.prepareRecovery(['Rw'])).toThrow('Invalid recovery');
  expect(() => engine.prepareRecovery([])).toThrow('do not solve');
  expect(engine.phase).toBe('recovery');
});

test('preparing the next scramble preserves the result and timing until the next solve starts', () => {
  const { engine, turn } = create();
  turn('R'); turn('U2'); turn('U'); turn('U'); turn("R'");
  const result = engine.result!;
  engine.prepare('F L2');
  expect(engine.phase).toBe('scrambling');
  expect(engine.elapsed(10000)).toBe(200);
  expect(engine.result).toBe(result);
  turn('F'); turn('L2');
  expect(engine.phase).toBe('ready');
  expect(engine.elapsed(10000)).toBe(200);
  turn('L');
  expect(engine.active?.moves[0].elapsed).toBe(0);
  expect(engine.elapsed(engine.active!.moves[0].hostTime)).toBe(0);
  turn('L'); turn("F'");
  expect(engine.result?.id).not.toBe(result.id);
  expect(engine.result?.status).toBe('complete');
  expect(result.status).toBe('complete');
});

test('automatic next preparation does not bypass post-solve snapshot validation', () => {
  const { engine, records, turn } = create();
  turn('R'); turn('U2'); turn('U2'); turn("R'");
  engine.prepare('F');
  engine.snapshot(cube.facelets(cube.solved().applyMove('R')));
  expect(engine.phase).toBe('recovery');
  expect(engine.result?.status).toBe('incomplete');
  expect(records.at(-1)?.status).toBe('incomplete');
});

test('a mismatch after a new scramble turn does not invalidate the previous completed solve', () => {
  const { engine, turn } = create();
  turn('R'); turn('U2'); turn('U2'); turn("R'");
  engine.prepare('F L2');
  turn('F');
  engine.snapshot(SOLVED);
  expect(engine.phase).toBe('recovery');
  expect(engine.result?.status).toBe('complete');
});

test('preparation failure does not invalidate an already completed solve', () => {
  const { engine, turn } = create();
  turn('R'); turn('U2'); turn('U2'); turn("R'");
  engine.fail('Scramble generation failed.', false);
  expect(engine.phase).toBe('recovery');
  expect(engine.result?.status).toBe('complete');
});

test('arbitrary synchronized cube state requires a valid solving setup', () => {
  const { engine } = create();
  engine.synchronize(cube.facelets(cube.solved().applyMove('F')));
  expect(() => engine.prepare('R')).toThrow('Setup');
  engine.prepare('R', ["F'"]);
  expect(engine.instructions).toEqual(["F'", 'R']);
});

test('turns during synchronization require a new snapshot', () => {
  const { engine, turn } = create();
  engine.connect('Other cube');
  turn('R');
  expect(engine.phase).toBe('recovery');
});

test('device clock fitting is used only for complete, consistent clock pairs', () => {
  const moves: RecordedTurn[] = Array.from({ length: 6 }, (_, i) => ({
    move: 'U', hostTime: 1000 + i * 105, elapsed: i * 105,
    localTimestamp: 1000 + i * 105, cubeTimestamp: 4000 + i * 100,
  }));
  expect(finalizeTiming(moves)).toEqual({ timingBasis: 'device-fit', duration: 525 });
  moves[3].cubeTimestamp = null;
  expect(finalizeTiming(moves)).toEqual({ timingBasis: 'host', duration: 525 });
});

test('inverse scramble solves and retains every repeated turn', () => {
  const { engine, turn } = create("R U R' F2 D L2");
  engine.instructions.forEach(move => turn(move));
  engine.scramble.split(' ').reverse().map(inverse).forEach(move => turn(move));
  expect(engine.result?.status).toBe('complete');
  expect(engine.result?.moves).toHaveLength(6);
});
