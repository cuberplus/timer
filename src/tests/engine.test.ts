import { jest } from '@jest/globals';
import { TimerEngine, finalizeTiming, type RecordedTurn, type Solve } from '../engine';
import { Cube, SOLVED, inverse, loadCube } from '../puzzle';

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
  expect(engine.nextMove).toBe("U'");
  turn("U'");
  expect(engine.phase).toBe('ready');
  expect(records).toHaveLength(0);
  expect(engine.active).toBeNull();
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

test('mistakes guide back to the last checkpoint without starting timing', () => {
  const { engine, turn } = create();
  turn('L'); turn('F');
  expect(engine.recovery).toEqual(["F'", "L'"]);
  turn("F'");
  expect(engine.nextMove).toBe("L'");
  turn("L'");
  expect(engine.recovery).toEqual([]);
  expect(engine.progress).toBe(0);
  turn('R'); turn('U2');
  expect(engine.phase).toBe('ready');
});

test('undoing a partial double turn returns to its checkpoint', () => {
  const { engine, turn } = create();
  turn('R'); turn('U'); turn("U'");
  expect(engine.progress).toBe(1);
  expect(engine.nextMove).toBe('U2');
  expect(engine.recovery).toEqual([]);
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
