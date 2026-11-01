import { useEffect, useMemo, useRef, useState } from 'react';
import { getDnfReason, type Solve } from './engine';
import { Cube, movesOf } from './puzzle';
import { CubeView } from './CubeView';
import { formatTime, turns } from './storage';
import { analyzeCFOP, CFOP_STEPS } from './cfop';

export function Replay({ cube, solve, close, precision = 2 }: { cube: Cube; solve: Solve; close: () => void; precision?: 2 | 3 }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const moves = useMemo(() => solve.moves.map(turn => turn.move), [solve]);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const dismiss = () => { dialog.current?.close(); close(); };
  const steps = useMemo(() => {
    const { ends } = analyzeCFOP(solve, cube);
    return CFOP_STEPS.map((name, step) => {
      const start = step ? ends[step - 1] ?? solve.moves.length : 0;
      const end = step === 6 ? solve.moves.length : ends[step] ?? solve.moves.length;
      const groups: { notation: string; start: number; end: number; amount: number }[] = [];
      for (let i = start; i < end; i++) {
        const notation = solve.moves[i].move, amount = notation.includes('2') ? 2 : notation.endsWith("'") ? -1 : 1;
        const previous = groups.at(-1);
        if (previous?.notation === notation) { previous.end = i + 1; previous.amount += amount; }
        else groups.push({ notation, start: i, end: i + 1, amount });
      }
      return {
        name: name.replace('Slot', 'Pair'),
        empty: step > ends.length ? 'Not reached' : ends[step] === undefined ? 'No moves recorded' : 'Skipped',
        groups: groups.map(group => ({ ...group, move: group.notation[0] + ['4', '', '2', "'"][(group.amount % 4 + 4) % 4] })),
      };
    });
  }, [cube, solve]);
  useEffect(() => {
    if (!playing || position >= solve.moves.length) { setPlaying(false); return; }
    const before = position ? solve.moves[position - 1].elapsed : 0, delay = Math.max(20, (solve.moves[position].elapsed - before) / speed);
    const timeout = setTimeout(() => setPosition(p => p + 1), delay);
    return () => clearTimeout(timeout);
  }, [playing, position, speed, solve]);
  const alg = solve.moves.slice(0, position).map(move => move.move).join(' '), facelets = cube.facelets(cube.parse(solve.startFacelets).applyAlg(alg));
  return <dialog ref={dialog} className="panel replay-dialog" aria-labelledby="replay-title" onCancel={event => { event.preventDefault(); dismiss(); }}>
    <div className="d-flex justify-content-between"><h2 id="replay-title">Solve replay</h2><button autoFocus className="btn btn-outline-secondary" onClick={dismiss}>Close replay</button></div>
    <p>{solve.status} - {formatTime(solve.duration, precision)}s - {turns(solve)} quarter turns - {solve.timingBasis} timing</p>
    <p className="small text-secondary" aria-label="Inspection time">Inspection: {solve.inspection === undefined ? 'Not recorded' : `${formatTime(solve.inspection, precision)}s`}</p>
    <p className="scramble">{movesOf(solve.scramble).join(' ')}</p>
    <CubeView cube={cube} facelets={facelets} moves={moves} position={position} speed={speed} />
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
    <div className="move-timeline" role="group" aria-label="Solution steps">{steps.map(step => <div key={step.name} role="group" aria-label={`${step.name} solution`} className="mb-2">
      <h3 className="replay-step-name">{step.name}</h3>
      {step.groups.length ? step.groups.map(group => {
        const current = position === 0 ? group.start === 0 : group.start < position && position <= group.end;
        return <button key={group.start} className={`move ${group.end <= position ? 'done' : ''} ${current ? 'current' : ''} ${current && position > group.start && position < group.end ? 'partial' : ''}`}
          title={`${formatTime(solve.moves[group.end - 1].elapsed, precision)}s`} aria-current={current ? 'step' : undefined}
          aria-label={`${group.move}, recorded moves ${group.start + 1} to ${group.end}: ${solve.moves.slice(group.start, group.end).map(move => move.move).join(' ')}`}
          onClick={() => { setPlaying(false); setPosition(group.end); }}>{group.move}</button>;
      }) : <span className="small text-secondary">{step.empty}</span>}
    </div>)}</div>
    {solve.status === 'incomplete' ? <p className="text-warning mt-2" aria-label="Penalty reason">DNF reason: {getDnfReason(solve)}</p> :
      solve.penalty === 2000 && <p className="text-warning mt-2" aria-label="Penalty reason">+2 reason: {solve.penaltyReason ?? 'over-turn'}</p>}
    {solve.reason && solve.reason !== 'Solve aborted by user.' && <p className="text-secondary small mt-2">{solve.reason}</p>}
    <p className="small text-secondary text-break mt-3 mb-0" aria-label="Solve ID">Solve ID: <span className="font-monospace">{solve.id}</span></p>
  </dialog>;
}
