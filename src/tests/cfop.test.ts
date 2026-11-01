import type { Solve } from '../engine';
import { analyzeCFOP, cfopFrame, cfopTiming, elapsedAt } from '../cfop';
import { Cube, inverse, loadCube, SOLVED } from '../puzzle';

let cube: Cube;
beforeAll(async () => { cube = await loadCube(); });
const PLL = "R U R' U' R' F R2 U' R' U' R U R' F'";
const OLL = "R U R' U R U2 R'";
const EXTRACT = ["R U R'", "F U F'", "L U L'", "B U B'"];
const scramble = [PLL, OLL, ...EXTRACT, 'D'].join(' ');
const undo = (alg: string) => alg.split(/\s+/).reverse().map(inverse).join(' ');
const solution = ['D', ...[...EXTRACT].reverse(), OLL, PLL].map(undo);

function recording(alg: string): Solve {
  return {
    version: 1, id: crypto.randomUUID(), session: 'Test', createdAt: new Date().toISOString(), device: 'Test cube',
    scramble: alg, startFacelets: cube.facelets(cube.solved().applyAlg(alg)), duration: 0, status: 'active',
    reason: '', timingBasis: 'host', moves: [], orientations: [],
  };
}
function append(solve: Solve, alg: string) {
  for (const move of alg.split(/\s+/).filter(Boolean)) {
    const elapsed = solve.moves.length * 100;
    solve.moves.push({ move, elapsed, hostTime: 1000 + elapsed, localTimestamp: 1000 + elapsed, cubeTimestamp: null });
    solve.duration = elapsed;
    analyzeCFOP(solve, cube);
  }
  return analyzeCFOP(solve, cube);
}
// Independent sticker-position oracle for D-layer pairs; not the detector's orbit tables.
const slots = [[29, 26, 15, 23, 12], [27, 44, 24, 21, 41], [33, 53, 42, 50, 39], [35, 17, 51, 48, 14]];
const pairs = (facelets: string) => slots.map(indices => indices.every(i => facelets[i] === SOLVED[i]));
const state = (solve: Solve) => cube.parse(solve.startFacelets).applyAlg(solve.moves.map(move => move.move).join(' '));

test.each(['', 'x2', 'z', "z'", 'x', "x'"])('detects all seven milestones on the first cross face in rotated frame "%s"', rotation => {
  const centers = cube.solved().applyAlg(rotation).patternData.CENTERS.pieces;
  const remap = (alg: string) => alg.split(/\s+/).map(move => 'ULFRBD'[centers.indexOf('ULFRBD'.indexOf(move[0]))] + move.slice(1)).join(' ');
  const solve = recording(remap(scramble)), face = 'URFDLB'.indexOf(remap('D'));
  expect(analyzeCFOP(solve, cube)).toEqual({ cross: null, ends: [] });
  for (let i = 0; i < solution.length; i++) {
    const analysis = append(solve, remap(solution[i]));
    expect(analyzeCFOP(structuredClone(solve), cube)).toEqual(analysis);
    expect(analysis.cross).toBe(face);
    expect(analysis.ends).toHaveLength(i + 1);
    if (i < 6) expect(cube.isSolved(state(solve))).toBe(false);
  }
  expect(cube.isSolved(state(solve))).toBe(true);
  expect(analyzeCFOP(solve, cube).ends.at(-1)).toBe(solve.moves.length);
  expect(cfopFrame(cube, face)('URFDLB'[face])).toBe('D');
  expect(cfopFrame(cube, face)('URFDLB'[[3, 4, 5, 0, 1, 2][face]])).toBe('U');
});

test('same-colored but misaligned crosses do not complete Cross', () => {
  const solve = recording(PLL + ' D');
  expect(solve.startFacelets.slice(0, 9)).toBe('U'.repeat(9));
  expect([28, 30, 32, 34].every(i => solve.startFacelets[i] === 'D')).toBe(true);
  expect(analyzeCFOP(solve, cube)).toEqual({ cross: null, ends: [] });
  const analysis = append(solve, "D'");
  expect(analysis.cross).toBe(3);
  expect(analysis.ends).toHaveLength(6);
});

test('initially completed stages are skipped, milestones stay latched, and PLL includes final AUF', () => {
  const solve = recording('U');
  expect(analyzeCFOP(solve, cube)).toEqual({ cross: 3, ends: [0, 0, 0, 0, 0, 0] });
  append(solve, 'R');
  expect(analyzeCFOP(solve, cube).cross).toBe(3);
  expect(analyzeCFOP(solve, cube).ends).toHaveLength(6);
  append(solve, "R'");
  expect(analyzeCFOP(solve, cube).ends).toHaveLength(6);
  append(solve, "U'");
  expect(analyzeCFOP(solve, cube).ends).toHaveLength(7);
});

test('solving a different set of three pairs never counts four pairs cumulatively', () => {
  const solve = recording(PLL + " R U R'");
  const firstMask = pairs(solve.startFacelets);
  expect(firstMask.filter(Boolean)).toHaveLength(3);
  expect(analyzeCFOP(solve, cube).ends).toHaveLength(4);
  const inserts = [...'RFLB'].flatMap(face => ['', "'"].flatMap(suffix =>
    ['U', "U'", 'U2'].map(top => `${face}${suffix} ${top} ${inverse(face + suffix)}`)));
  const restores = ['', 'U', "U'", 'U2'].flatMap(top => inserts.map(insert => `${top} ${insert}`.trim()));
  const candidates = inserts.flatMap(extract => restores.map(restore => `${extract} ${restore}`));
  const another = candidates.find(alg => {
    let pattern = state(solve);
    for (const turn of alg.split(' ')) {
      pattern = pattern.applyMove(turn);
      if (pairs(cube.facelets(pattern)).every(Boolean)) return false;
    }
    const mask = pairs(cube.facelets(pattern));
    return mask.filter(Boolean).length === 3 && mask.some((done, i) => done && !firstMask[i]);
  });
  expect(another).toBeDefined();
  append(solve, another!);
  expect(analyzeCFOP(solve, cube).ends).toHaveLength(4);
});

test('additional F2L milestones cannot complete while the locked cross is broken', () => {
  const solve = recording(scramble);
  append(solve, solution[0]); append(solve, solution[1]);
  const edgePermutation = "R D' R D R D R D' R' D' R2";
  append(solve, edgePermutation);
  solution.slice(2, 5).forEach(alg => append(solve, alg));
  expect(pairs(cube.facelets(state(solve))).filter(Boolean)).toHaveLength(4);
  expect(analyzeCFOP(solve, cube).ends).toHaveLength(2);
  append(solve, undo(edgePermutation));
  expect(analyzeCFOP(solve, cube).ends).toHaveLength(5);
});

test('incomplete and invalidated recordings never claim PLL completion', () => {
  const solve = recording(scramble);
  solution.forEach(alg => append(solve, alg));
  expect(analyzeCFOP(solve, cube).ends).toHaveLength(7);
  solve.status = 'incomplete';
  expect(analyzeCFOP(solve, cube).ends).toHaveLength(6);
});

test('step clocks use validated fitted device time without altering the raw recording', () => {
  const solve = recording('U');
  append(solve, 'R R R R U U U');
  solve.moves.forEach((move, i) => { move.cubeTimestamp = 3000 + i * 100; });
  solve.timingBasis = 'device-fit'; solve.duration = 630;
  expect(elapsedAt(solve, 0)).toBe(0);
  expect(elapsedAt(solve, 4)).toBe(315);
  expect(elapsedAt(solve, 7)).toBe(630);
  expect(solve.moves[3].elapsed).toBe(300);
});

test('live step timing switches from recognition to execution on the first new turn', () => {
  const solve = recording(scramble);
  append(solve, "D'");
  expect(cfopTiming(solve, analyzeCFOP(solve, cube).ends, 1, 50)).toEqual({
    start: 0, end: 50, time: 50, recognition: 50, execution: 0,
  });
  append(solve, 'B');
  expect(cfopTiming(solve, analyzeCFOP(solve, cube).ends, 1, 180)).toEqual({
    start: 0, end: 180, time: 180, recognition: 100, execution: 80,
  });
  append(solve, "U' B'");
  const ends = analyzeCFOP(solve, cube).ends;
  expect(cfopTiming(solve, ends, 1)).toEqual({ start: 0, end: 300, time: 300, recognition: 100, execution: 200 });
  expect(cfopTiming(solve, ends, 2, 380)).toEqual({ start: 300, end: 380, time: 80, recognition: 80, execution: 0 });
});

test('fitted-device step splits partition the full duration, including skipped stages', () => {
  const solve = recording(scramble);
  append(solve, "U U'");
  solution.forEach(alg => append(solve, alg));
  solve.status = 'complete'; solve.timingBasis = 'device-fit'; solve.duration *= 1.057;
  solve.moves.forEach((move, i) => { move.cubeTimestamp = 5000 + i * 100; });
  const steps = analyzeCFOP(solve, cube).ends.map((_, i, ends) => cfopTiming(solve, ends, i));
  expect(steps.reduce((sum, step) => sum + step.recognition + step.execution, 0)).toBe(Math.round(solve.duration));
  const skipped = recording('U'), ends = analyzeCFOP(skipped, cube).ends;
  expect(ends.map((_, i) => cfopTiming(skipped, ends, i).time)).toEqual([0, 0, 0, 0, 0, 0]);
});
