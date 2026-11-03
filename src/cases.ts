import type { KPattern } from 'cubing/kpuzzle';
import { crossRotation, type Cube } from './puzzle';

// Canonical states from SpeedCubeDB's 3x3 OLL, PLL, and F2L catalogs; no algorithm matching.
const numbered = (keys: string) => new Map(keys.split(' ').map((key, i) => [key, String(i + 1)]));
const oll = numbered(
  '12121111 11221111 02221111 01111111 02220011 01110011 02220110 01111001 01111100 02221100 02221001 01110110 ' +
  '02220101 01111010 02221010 01110101 01021111 00121111 00211111 00001111 12120000 11220000 00120000 00210000 ' +
  '01020000 01110000 02220000 00000011 00211100 00210110 00211001 00210011 00211010 00210101 01021100 01021001 ' +
  '01020011 01020110 01020101 01021010 00120110 00121100 00121001 00120011 00121010 00120101 11221100 11221001 ' +
  '11220011 11220110 11220101 11221010 12120011 12120110 12120101 12121010 00000101',
);
const f2l = numbered(
  '0,2,1,0 0,1,0,1 0,2,3,1 0,1,2,0 0,2,2,0 0,1,3,1 0,2,3,0 0,1,2,1 0,2,2,1 0,1,3,0 0,2,1,1 0,1,0,0 ' +
  '0,2,0,1 0,1,1,0 0,2,0,0 0,1,1,1 0,0,1,0 0,0,0,1 0,0,2,0 0,0,3,1 0,0,3,0 0,0,2,1 0,0,0,0 0,0,1,1 ' +
  '4,0,0,0 4,0,0,1 4,1,0,0 4,2,0,1 4,1,0,1 4,2,0,0 0,0,8,1 0,0,8,0 0,2,8,0 0,1,8,0 0,2,8,1 0,1,8,1 ' +
  '4,0,8,1 4,1,8,0 4,2,8,0 4,1,8,1 4,2,8,1',
);
const pll = new Map(Object.entries({
  '002310121233': 'Aa', '001212320133': 'Ab', '012321230103': 'E', '000132321213': 'F',
  '011230102323': 'Ga', '020132311203': 'Gb', '001232310123': 'Gc', '002320131213': 'Gd',
  '020131202313': 'H', '000112331223': 'Ja', '000122311233': 'Jb', '022311200133': 'Na',
  '002331220113': 'Nb', '001210132323': 'Ra', '010102321233': 'Rb', '001230122313': 'T',
  '000121232313': 'Ua', '000131212323': 'Ub', '002321210133': 'V', '002311230123': 'Y', '010101232323': 'Z',
}));
const aufs = ['', 'U', 'U2', "U'"], spins = ['', 'y', 'y2', "y'"];
function normalized(cube: Cube, pattern: KPattern, rotation: string): KPattern {
  const turned = pattern.applyAlg(rotation), centers = turned.patternData.CENTERS.pieces;
  // Cube.facelets keeps fixed centers; relabel rotated cubies and restore calibrated centers.
  return cube.parse([...cube.facelets(turned)].map((face, i) => i % 9 === 4 ? 'URFDLB'[Math.floor(i / 9)] :
    'ULFRBD'[centers.indexOf('ULFRBD'.indexOf(face))]).join(''));
}
const pairSolved = (pattern: KPattern) => ['CORNERS', 'EDGES'].every((orbit, i) => {
  const slot = i ? 8 : 4, data = pattern.patternData[orbit];
  return data.pieces[slot] === slot && data.orientation[slot] === 0;
});
export function recognizeCase(step: number, cube: Cube, cross: number, before: KPattern, after: KPattern): string {
  if (!step) return '';
  before = normalized(cube, before, crossRotation(cross));
  if (step < 5) {
    after = normalized(cube, after, crossRotation(cross));
    const targets = spins.map(spin => [normalized(cube, before, spin), normalized(cube, after, spin)])
      .filter(([start, end]) => !pairSolved(start) && pairSolved(end));
    if (targets.length !== 1) return '';
    const key = aufs.map(auf => {
      const data = targets[0][0].applyAlg(auf).patternData, corner = data.CORNERS.pieces.indexOf(4), edge = data.EDGES.pieces.indexOf(8);
      return [corner, data.CORNERS.orientation[corner], edge, data.EDGES.orientation[edge]].join(',');
    }).sort()[0];
    return f2l.get(key) ?? '';
  }
  if (step === 5) {
    const key = aufs.map(auf => {
      const data = before.applyAlg(auf).patternData;
      return [...data.CORNERS.orientation.slice(0, 4), ...data.EDGES.orientation.slice(0, 4)].join('');
    }).sort()[0];
    return key === '00000000' ? 'Solved' : oll.get(key) ?? '';
  }
  const facelets = cube.facelets(before), ring = [18, 19, 20, 9, 10, 11, 45, 46, 47, 36, 37, 38].map(i => 'FRBL'.indexOf(facelets[i]));
  const key = [0, 1, 2, 3].flatMap(turn => [0, 1, 2, 3].map(offset =>
    ring.map((_, i) => (ring[(i + turn * 3) % 12] + offset) % 4).join(''))).sort()[0];
  return key === '000111222333' ? 'Solved' : pll.get(key) ?? '';
}
