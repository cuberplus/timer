import { KPattern, type KPatternData, type KPuzzle } from 'cubing/kpuzzle';
import { puzzles } from 'cubing/puzzles';
import { randomScrambleForEvent } from 'cubing/scramble';
import { experimentalSolve3x3x3IgnoringCenters } from 'cubing/search';

export const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
export const isMove = (move: string): boolean => /^[URFDLB](2|'|2')?$/.test(move);
export const movesOf = (alg: string): string[] => alg.trim() ? alg.trim().split(/\s+/) : [];
export const inverse = (move: string): string => move.includes('2') ? move[0] + '2' : move.endsWith("'") ? move[0] : move + "'";
export const sameAxis = (first: string, second: string): boolean => ['UD', 'RL', 'FB'].some(axis => axis.includes(first[0]) && axis.includes(second[0]));
export function simplifyMoves(moves: readonly string[]): string[] {
  const result: string[] = [];
  const amount = (move: string) => move.includes('2') ? 2 : move.endsWith("'") ? 3 : 1;
  const notation = (face: string, turns: number) => face + (turns === 2 ? '2' : turns === 3 ? "'" : '');
  for (const move of moves) {
    let merged = false;
    // Search across opposite-face turns only; all other move order stays unchanged.
    for (let i = result.length - 1; i >= 0 && sameAxis(result[i], move); i--) {
      if (result[i][0] !== move[0]) continue;
      const turns = (amount(result[i]) + amount(move)) % 4;
      if (turns) result[i] = notation(move[0], turns);
      else result.splice(i, 1);
      merged = true;
      break;
    }
    if (!merged) result.push(notation(move[0], amount(move)));
  }
  return result;
}

// Facelet locations in cubing.js's Reid orbit order; centers are ULFRBD.
export const locations = {
  EDGES: [[7, 19], [5, 10], [1, 46], [3, 37], [28, 25], [32, 16], [34, 52], [30, 43], [23, 12], [21, 41], [48, 14], [50, 39]],
  CORNERS: [[8, 9, 20], [2, 45, 11], [0, 36, 47], [6, 18, 38], [29, 26, 15], [27, 44, 24], [33, 53, 42], [35, 17, 51]],
};
const parity = (pieces: number[]): number => pieces.reduce((n, piece, i) => n + pieces.slice(i + 1).filter(other => other < piece).length, 0) % 2;

export class Cube {
  constructor(readonly puzzle: KPuzzle) {}
  solved(): KPattern { return this.puzzle.defaultPattern(); }
  facelets(pattern: KPattern): string {
    const stickers = SOLVED.split('');
    for (const orbit of ['EDGES', 'CORNERS'] as const) {
      const data = pattern.patternData[orbit];
      locations[orbit].forEach((indices, position) => indices.forEach((index, sticker) => {
        stickers[index] = SOLVED[locations[orbit][data.pieces[position]][(sticker - data.orientation[position] + indices.length) % indices.length]];
      }));
    }
    return stickers.join('');
  }
  parse(facelets: string): KPattern {
    if (facelets.length !== 54 || [...'URFDLB'].some((face, i) =>
      facelets[i * 9 + 4] !== face || [...facelets].filter(c => c === face).length !== 9)) {
      throw new Error('Expected a legal 3x3 state in the calibrated URFDLB frame.');
    }
    const data: KPatternData = structuredClone(this.solved().patternData);
    for (const orbit of ['EDGES', 'CORNERS'] as const) {
      const size = locations[orbit][0].length;
      locations[orbit].forEach((indices, position) => {
        const piece = locations[orbit].findIndex(home => home.some((_, twist) =>
          indices.every((index, sticker) => facelets[index] === SOLVED[home[(sticker - twist + size) % size]])));
        if (piece < 0) throw new Error('Invalid cube pieces.');
        data[orbit].pieces[position] = piece;
        data[orbit].orientation[position] = Array.from({ length: size }, (_, twist) => twist).find(twist =>
          indices.every((index, sticker) => facelets[index] === SOLVED[locations[orbit][piece][(sticker - twist + size) % size]]))!;
      });
      if (new Set(data[orbit].pieces).size !== locations[orbit].length ||
          data[orbit].orientation.reduce((a, b) => a + b, 0) % size) throw new Error('Invalid cube orientation.');
    }
    if (parity(data.EDGES.pieces) !== parity(data.CORNERS.pieces)) throw new Error('Invalid cube parity.');
    return new KPattern(this.puzzle, data);
  }
  equals(a: KPattern, b: KPattern): boolean { return this.facelets(a) === this.facelets(b); }
  isSolved(pattern: KPattern): boolean { return pattern.experimentalIsSolved({ ignoreCenterOrientation: true, ignorePuzzleOrientation: true }); }
  async solution(facelets: string): Promise<string[]> {
    return movesOf((await experimentalSolve3x3x3IgnoringCenters(this.parse(facelets))).toString());
  }
}

export const loadCube = async (): Promise<Cube> => new Cube(await puzzles['3x3x3'].kpuzzle());
export const generateScramble = async (): Promise<string> => simplifyMoves(movesOf((await randomScrambleForEvent('333')).toString())).join(' ');
