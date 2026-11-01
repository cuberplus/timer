import { useEffect, useState } from 'react';
import type { Solve } from './engine';
import { Cube, movesOf } from './puzzle';
import { CubeView } from './CubeView';
import { formatTime, turns } from './storage';

export function Replay({ cube, solve, close, precision = 2 }: { cube: Cube; solve: Solve; close: () => void; precision?: 2 | 3 }) {
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  useEffect(() => {
    if (!playing || position >= solve.moves.length) { setPlaying(false); return; }
    const before = position ? solve.moves[position - 1].elapsed : 0, delay = Math.max(20, (solve.moves[position].elapsed - before) / speed);
    const timeout = setTimeout(() => setPosition(p => p + 1), delay);
    return () => clearTimeout(timeout);
  }, [playing, position, speed, solve]);
  const alg = solve.moves.slice(0, position).map(move => move.move).join(' '), facelets = cube.facelets(cube.parse(solve.startFacelets).applyAlg(alg));
  return <section className="panel mt-3" aria-label="Solve replay">
    <div className="d-flex justify-content-between"><h2>Replay</h2><button className="btn btn-outline-secondary" onClick={close}>Close replay</button></div>
    <p>{solve.status} - {formatTime(solve.duration, precision)}s - {turns(solve)} quarter turns - {solve.timingBasis} timing</p>
    <p className="scramble">{movesOf(solve.scramble).join(' ')}</p>
    <CubeView cube={cube} facelets={facelets} />
    <div className="d-flex gap-2 align-items-center flex-wrap">
      <button className="btn btn-primary" disabled={!solve.moves.length} onClick={() => { if (position >= solve.moves.length) setPosition(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</button>
      <button className="btn btn-outline-secondary" disabled={position === 0} onClick={() => { setPlaying(false); setPosition(p => p - 1); }}>Previous move</button>
      <button className="btn btn-outline-secondary" disabled={position >= solve.moves.length} onClick={() => { setPlaying(false); setPosition(p => p + 1); }}>Next move</button>
      <select className="form-select replay-speed" aria-label="Replay speed" value={speed} onChange={event => setSpeed(Number(event.target.value))}>
        {[0.25, 0.5, 1, 2, 4].map(value => <option key={value} value={value}>{value}x</option>)}
      </select>
      <span>{position}/{solve.moves.length} moves - {formatTime(position ? solve.moves[position - 1].elapsed : 0, precision)}s</span>
    </div>
    <input className="form-range mt-3" type="range" min={0} max={solve.moves.length} value={position} aria-label="Replay move" onChange={event => { setPlaying(false); setPosition(Number(event.target.value)); }} />
    <div className="move-timeline">{solve.moves.map((move, i) => <button key={i} className={`move ${i < position ? 'done' : ''}`} title={`${formatTime(move.elapsed, precision)}s`} onClick={() => { setPlaying(false); setPosition(i + 1); }}>{move.move}</button>)}</div>
    {solve.reason && <p className="text-warning mt-2">{solve.reason}</p>}
  </section>;
}
