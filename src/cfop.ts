import type { KPattern } from 'cubing/kpuzzle';
import type { Solve } from './engine';
import { locations, type Cube } from './puzzle';

export const CFOP_STEPS = ['Cross', 'F2L Slot 1', 'F2L Slot 2', 'F2L Slot 3', 'F2L Slot 4', 'OLL', 'PLL'];
const edges = locations.EDGES.map(stickers => stickers.map(index => Math.floor(index / 9)));
const corners = locations.CORNERS.map(stickers => stickers.map(index => Math.floor(index / 9)));
const layers = [...'URFDLB'].map((_, face) => ({
  cross: edges.flatMap((sides, i) => sides.includes(face) ? [i] : []),
  pairs: corners.flatMap((sides, i) => sides.includes(face) ? [[i, edges.findIndex(edge => !edge.includes(face) && edge.every(side => sides.includes(side)))]] : []),
}));
const cache = new WeakMap<Solve, { pattern: KPattern; processed: number; cross: number | null; ends: number[] }>();
export function analyzeCFOP(solve: Solve, cube: Cube): { cross: number | null; ends: number[] } {
  const state = cache.get(solve) ?? { pattern: cube.parse(solve.startFacelets), processed: 0, cross: null, ends: [] }; cache.set(solve, state);
  const check = (end: number) => {
    const solved = (orbit: 'EDGES' | 'CORNERS', i: number) => state.pattern.patternData[orbit].pieces[i] === i && state.pattern.patternData[orbit].orientation[i] === 0;
    const cross = (face: number) => layers[face].cross.every(i => solved('EDGES', i));
    // Simultaneous initial crosses use a deterministic D-first tie-break.
    state.cross ??= [3, 0, 1, 2, 4, 5].find(cross) ?? null;
    if (state.cross === null || !cross(state.cross)) return;
    const pairs = layers[state.cross].pairs.filter(([corner, edge]) => solved('CORNERS', corner) && solved('EDGES', edge)).length;
    const top = [3, 4, 5, 0, 1, 2][state.cross], facelets = cube.facelets(state.pattern);
    const done = [true, ...[1, 2, 3, 4].map(count => pairs >= count), pairs === 4 && [...facelets.slice(top * 9, top * 9 + 9)].every(face => face === 'URFDLB'[top]), cube.isSolved(state.pattern)];
    while (state.ends.length < done.length && done[state.ends.length]) state.ends.push(end);
  };
  if (state.processed === 0) check(0);
  while (state.processed < solve.moves.length) { state.pattern = state.pattern.applyMove(solve.moves[state.processed].move); check(++state.processed); }
  return { cross: state.cross, ends: solve.status === 'incomplete' ? state.ends.slice(0, 6) : state.ends };
}
export function elapsedAt(solve: Solve, end: number): number {
  const move = solve.moves[end - 1], first = solve.moves[0], span = (solve.moves.at(-1)?.cubeTimestamp ?? 0) - (first?.cubeTimestamp ?? 0);
  return !move ? 0 : solve.timingBasis === 'device-fit' && first.cubeTimestamp !== null && move.cubeTimestamp !== null && span > 0 ? solve.duration * (move.cubeTimestamp - first.cubeTimestamp) / span : move.elapsed;
}
export function cfopTiming(solve: Solve, ends: number[], step: number, elapsed = solve.duration) {
  const from = ends[step - 1] ?? 0, to = ends[step], start = Math.round(elapsedAt(solve, from));
  const end = to === undefined ? Math.max(start, Math.round(elapsed)) : Math.round(elapsedAt(solve, to)), time = end - start;
  const recognition = step === 0 || from === to ? 0 : !solve.moves[from] ? time : Math.min(time, Math.max(0, Math.round(elapsedAt(solve, from + 1)) - start));
  return { start, end, time, recognition, execution: time - recognition };
}
export function cfopFrame(cube: Cube, cross: number): (move: string) => string {
  const centers = cube.solved().applyAlg(['x2', 'z', "x'", '', "z'", 'x'][cross]).patternData.CENTERS.pieces;
  return move => 'ULFRBD'[centers.indexOf('ULFRBD'.indexOf(move[0]))] + move.slice(1);
}
