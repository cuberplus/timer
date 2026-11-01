import type { KPattern } from 'cubing/kpuzzle';
import { Cube, inverse, isMove, movesOf, sameAxis, simplifyMoves } from './puzzle';

export type Phase = 'disconnected' | 'synchronizing' | 'scrambling' | 'ready' | 'solving' | 'finished' | 'recovery' | 'recovering';
export interface Turn {
  move: string; hostTime: number; serial?: number;
  localTimestamp: number | null; cubeTimestamp: number | null;
}
export interface RecordedTurn extends Turn { elapsed: number }
export interface Orientation { elapsed: number; quaternion: { x: number; y: number; z: number; w: number } }
export interface Solve {
  version: 1; id: string; session: string; createdAt: string; device: string;
  scramble: string; startFacelets: string; duration: number;
  inspection?: number;
  penalty?: 2000;
  penaltyReason?: 'over-turn';
  dnfReason?: 'solve interrupted' | 'solve aborted';
  status: 'active' | 'complete' | 'incomplete';
  reason: string; timingBasis: 'host' | 'device-fit';
  moves: RecordedTurn[]; orientations: Orientation[];
}

export const solveTime = (solve: Solve): number => solve.duration + (solve.status === 'complete' ? solve.penalty ?? 0 : 0);
export const getDnfReason = (solve: Solve): NonNullable<Solve['dnfReason']> =>
  solve.dnfReason ?? (solve.reason === 'Solve aborted by user.' ? 'solve aborted' : 'solve interrupted');

// GAN and MoYu history windows use circular 8-bit turn counters.
const serialDistance = (next: number, previous: number): number => (next - previous) & 0xff;

export function finalizeTiming(moves: RecordedTurn[]): { duration: number; timingBasis: Solve['timingBasis'] } {
  const host = moves.length ? moves[moves.length - 1].elapsed : 0;
  if (moves.length < 5 || moves.some(m => m.cubeTimestamp === null || m.localTimestamp === null)) return { duration: host, timingBasis: 'host' };
  const first = moves[0];
  const xs = moves.map(m => m.cubeTimestamp! - first.cubeTimestamp!);
  const ys = moves.map(m => m.localTimestamp! - first.localTimestamp!);
  if (xs.some((x, i) => i > 0 && x <= xs[i - 1]) || ys.some((y, i) => i > 0 && y < ys[i - 1])) return { duration: host, timingBasis: 'host' };
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length, meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const variance = xs.reduce((a, x) => a + (x - meanX) ** 2, 0);
  const slope = xs.reduce((a, x, i) => a + (x - meanX) * (ys[i] - meanY), 0) / variance;
  const residual = Math.sqrt(xs.reduce((a, x, i) => a + (ys[i] - (meanY + slope * (x - meanX))) ** 2, 0) / xs.length);
  if (!Number.isFinite(slope) || slope < 0.8 || slope > 1.2 || residual > 30) return { duration: host, timingBasis: 'host' };
  return { duration: Math.max(0, slope * xs[xs.length - 1]), timingBasis: 'device-fit' };
}

export class TimerEngine {
  phase: Phase = 'disconnected';
  pattern: KPattern;
  visualizationMoves: string[] = [];
  scramble = ''; progress = 0; instructions: string[] = [];
  completed: boolean[] = [];
  message = 'Connect your cube to begin.'; device = ''; session = 'Default';
  active: Solve | null = null; result: Solve | null = null;
  overTurnPenaltyEnabled = true;
  lastSerial: number | undefined;
  private checkpoints: KPattern[] = []; private partial: string[] = [];
  private guidanceStart = 0; private partialAllowed = false;
  private started = 0; private pendingResult = false;
  private finishedAt: number | null = null;
  private inspectionStarted: number | null = null;
  constructor(readonly cube: Cube, private readonly record: (solve: Solve) => void, private readonly changed: () => void) {
    this.pattern = cube.solved();
  }
  private setPhase(phase: Phase, message: string): void { this.inspectionStarted = null; this.phase = phase; this.message = message; this.changed(); }
  get facelets(): string { return this.cube.facelets(this.pattern); }
  get recovery(): string[] {
    return this.partialAllowed ? [] : simplifyMoves([...this.partial].reverse().map(inverse));
  }
  get nextMove(): string { return this.recovery[0] ?? this.partial[0] ?? this.instructions[this.progress] ?? ''; }
  get isPartialTurn(): boolean { return this.isPartialMove(this.progress); }
  isPartialMove(index: number): boolean {
    return (this.phase === 'scrambling' || this.phase === 'recovering') && this.partialAllowed && index >= this.guidanceStart && index < this.guidanceEnd &&
      this.partial.some(move => move[0] === this.instructions[index][0]);
  }
  private get guidanceEnd(): number {
    const setupCount = this.instructions.length - movesOf(this.scramble).length;
    const limit = this.guidanceStart < setupCount ? setupCount : this.instructions.length;
    let end = this.guidanceStart;
    while (end < limit && sameAxis(this.instructions[this.guidanceStart], this.instructions[end])) end++;
    return end;
  }
  connect(device: string): void {
    this.interrupt('Connection changed.');
    this.device = device; this.pendingResult = false; this.finishedAt = null; this.lastSerial = undefined;
    this.setPhase('synchronizing', 'Reading cube state. If unavailable, physically solve and confirm calibration.');
  }
  synchronize(facelets: string, serial?: number): void {
    const pattern = this.cube.parse(facelets);
    this.interrupt('Cube state was resynchronized.');
    this.pattern = pattern; this.lastSerial = serial; this.pendingResult = false; this.finishedAt = null;
    this.visualizationMoves = [];
    this.setPhase('synchronizing', 'State synchronized. Preparing scramble guidance.');
  }
  prepare(scramble: string, setup: string[] = []): void {
    const raw = movesOf(scramble);
    if (!raw.length || [...setup, ...raw].some(move => !isMove(move))) throw new Error('Invalid scramble or setup moves.');
    const moves = simplifyMoves(raw), setupMoves = simplifyMoves(setup);
    if (!moves.length) throw new Error('Invalid scramble or setup moves.');
    if (this.phase === 'disconnected' || this.phase === 'solving') throw new Error('Cannot prepare a scramble in this state.');
    const checkpoints = [this.pattern];
    [...setupMoves, ...moves].forEach(move => checkpoints.push(checkpoints[checkpoints.length - 1].applyMove(move)));
    if (!this.cube.equals(checkpoints[setupMoves.length], this.cube.solved())) throw new Error('Setup does not solve the current cube.');
    this.scramble = moves.join(' '); this.instructions = [...setupMoves, ...moves]; this.checkpoints = checkpoints;
    this.progress = 0; this.guidanceStart = 0; this.partial = []; this.partialAllowed = false;
    this.completed = this.instructions.map(() => false);
    this.setPhase('scrambling', setupMoves.length ? 'Follow setup moves to solve the cube, then scramble.' : 'Follow the highlighted scramble move.');
  }
  prepareRecovery(setup: string[]): void {
    if (!['recovery', 'synchronizing', 'recovering'].includes(this.phase) || this.active) throw new Error('Cannot prepare recovery in this state.');
    if (setup.some(move => !isMove(move))) throw new Error('Invalid recovery moves.');
    const moves = simplifyMoves(setup), checkpoints = [this.pattern];
    moves.forEach(move => checkpoints.push(checkpoints[checkpoints.length - 1].applyMove(move)));
    if (!this.cube.isSolved(checkpoints.at(-1)!)) throw new Error('Recovery moves do not solve the current cube.');
    this.scramble = ''; this.instructions = moves; this.checkpoints = checkpoints;
    this.progress = 0; this.guidanceStart = 0; this.partial = []; this.partialAllowed = false;
    this.completed = moves.map(() => false); this.pendingResult = false; this.finishedAt = null;
    this.setPhase(this.cube.isSolved(this.pattern) ? 'finished' : 'recovering',
      this.cube.isSolved(this.pattern) ? 'Cube solved. Preparing a new scramble.' : 'Return the cube to solved. Follow these moves or solve it your own way.');
  }
  snapshot(facelets: string, serial?: number): void {
    this.cube.parse(facelets);
    if (this.phase === 'synchronizing') { this.synchronize(facelets, serial); return; }
    // A stale history snapshot must not roll back newer recorded turns.
    const distance = serial !== undefined && this.lastSerial !== undefined ? serialDistance(serial, this.lastSerial) : 0;
    if (distance >= 240) return;
    if ((this.phase === 'recovery' && this.result?.status === 'incomplete') ||
        (this.phase === 'recovering' && (distance > 0 || facelets !== this.facelets))) {
      this.synchronize(facelets, serial);
      return;
    }
    if (distance > 0) {
      this.fail('Cube snapshot contains unrecorded turns. Resynchronize before continuing.');
      return;
    }
    if (facelets !== this.facelets) this.fail('Cube state differs from recorded moves. Resynchronize before continuing.');
  }
  turn(turn: Turn): void {
    if (!isMove(turn.move)) { this.fail('Unsupported face turn received.'); return; }
    if (this.phase === 'synchronizing') { this.fail('Cube turned before synchronization finished. Read its state again.'); return; }
    if (this.phase === 'disconnected' || this.phase === 'recovery') return;
    if (turn.serial !== undefined && this.lastSerial !== undefined) {
      const distance = serialDistance(turn.serial, this.lastSerial);
      if (distance === 0) return;
      if (distance !== 1) { this.fail('Move counter gap or reset detected. Resynchronize the cube.'); return; }
    }
    this.penalizeExtraTurn(turn);
    if (turn.serial !== undefined) this.lastSerial = turn.serial;
    if (this.phase === 'scrambling') this.pendingResult = false;
    if (this.phase === 'ready') {
      this.finishedAt = null;
      this.started = turn.hostTime;
      this.active = {
        version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), session: this.session,
        device: this.device, scramble: this.scramble, startFacelets: this.facelets,
        inspection: this.inspectionElapsed(turn.hostTime),
        duration: 0, status: 'active', reason: '', timingBasis: 'host', moves: [], orientations: [],
      };
      this.inspectionStarted = null;
      this.phase = 'solving';
    }
    this.pattern = this.pattern.applyMove(turn.move);
    this.visualizationMoves.push(turn.move);
    if (this.phase === 'solving' && this.active) {
      this.active.moves.push({ ...turn, elapsed: Math.max(0, turn.hostTime - this.started) });
      this.active.duration = this.active.moves[this.active.moves.length - 1].elapsed;
      if (this.cube.isSolved(this.pattern)) {
        Object.assign(this.active, finalizeTiming(this.active.moves), { status: 'complete' });
        this.result = this.active;
        this.active = null;
        this.phase = 'finished'; this.pendingResult = true; this.finishedAt = turn.hostTime;
        this.message = 'Solved! Your full move timeline is recorded.';
        this.record(this.result);
      } else this.record(this.active);
    } else if (this.phase === 'scrambling' || this.phase === 'recovering') this.guide(turn.move, turn.hostTime);
    this.changed();
  }
  // Preparation buffers turns, but their original arrival times still determine the penalty.
  penalizeExtraTurn(turn: Turn): void {
    if (this.finishedAt === null || this.result?.status !== 'complete' || !isMove(turn.move) ||
        ['disconnected', 'synchronizing', 'recovery'].includes(this.phase)) return;
    if (turn.serial !== undefined && this.lastSerial !== undefined && serialDistance(turn.serial, this.lastSerial) !== 1) return;
    const delay = turn.hostTime - this.finishedAt;
    if (delay < 0) return;
    this.finishedAt = null;
    if (delay <= 500 && this.overTurnPenaltyEnabled) {
      this.result.penalty = 2000;
      this.result.penaltyReason = 'over-turn';
      this.record(this.result);
      this.changed();
    }
  }
  private guide(move: string, hostTime: number): void {
    const target = this.checkpoints[this.checkpoints.length - 1];
    if (this.cube.equals(this.pattern, target)) {
      this.progress = this.instructions.length; this.partial = [];
      this.completed.fill(true); this.partialAllowed = false;
      if (this.phase === 'recovering') {
        this.phase = 'finished';
        this.message = 'Cube solved. Preparing a new scramble.';
      } else {
        this.phase = 'ready';
        this.inspectionStarted = hostTime;
        this.message = 'Scramble complete. Your next face turn starts the timer.';
      }
      return;
    }
    if (this.cube.isSolved(this.pattern)) {
      this.progress = this.instructions.length - movesOf(this.scramble).length;
      this.completed = this.instructions.map((_, i) => i < this.progress);
      this.guidanceStart = this.progress; this.partial = []; this.partialAllowed = false;
      this.message = 'Follow the highlighted scramble move.';
      return;
    }
    const end = this.guidanceEnd, block = this.instructions.slice(this.guidanceStart, end);
    const completed = block.filter((_, i) => this.completed[this.guidanceStart + i]);
    const checkpoint = this.checkpoints[this.guidanceStart].applyAlg(completed.join(' '));
    const partial = this.cube.equals(this.pattern, checkpoint) ? [] : simplifyMoves([...this.partial, move]);
    const observed = simplifyMoves([...completed, ...partial]);
    // Only the current commuting block can be reordered, never a later noncommuting step.
    this.partialAllowed = observed.every(turn => block.some(expected =>
      turn === expected || (expected.includes('2') && !turn.includes('2') && turn[0] === expected[0])));
    if (this.partialAllowed) {
      block.forEach((expected, i) => { this.completed[this.guidanceStart + i] = observed.includes(expected); });
      this.partial = observed.filter(turn => !block.includes(turn));
      this.progress = this.guidanceStart;
      while (this.completed[this.progress]) this.progress++;
      if (this.progress === end) this.guidanceStart = end;
    } else this.partial = partial;
    const partialTarget = block.find(expected => expected[0] === this.partial[0]?.[0]);
    this.message = this.recovery.length ? 'Wrong turn. Follow correction moves back to the checkpoint.'
      : this.partial.length ? `Turn ${this.partial[0]} once more to complete ${partialTarget}.` : 'Follow the highlighted move.';
  }
  gyro(quaternion: Orientation['quaternion'], hostTime: number): void {
    if (!this.active) return;
    this.active.orientations.push({ elapsed: Math.max(0, hostTime - this.started), quaternion });
  }
  interrupt(reason: string, dnfReason: NonNullable<Solve['dnfReason']> = 'solve interrupted'): void {
    if (!this.active) return;
    Object.assign(this.active, { status: 'incomplete', reason, dnfReason });
    this.result = this.active;
    this.record(this.active);
    this.active = null;
  }
  fail(reason: string, invalidateResult = true, dnfReason: NonNullable<Solve['dnfReason']> = 'solve interrupted'): void {
    this.finishedAt = null;
    if (invalidateResult && this.pendingResult && this.result?.status === 'complete') {
      Object.assign(this.result, { status: 'incomplete', reason, dnfReason });
      this.record(this.result);
    }
    this.interrupt(reason, dnfReason);
    this.setPhase('recovery', reason);
  }
  disconnect(): void {
    this.finishedAt = null;
    this.interrupt('Cube disconnected during the solve.');
    this.setPhase('disconnected', 'Cube disconnected. Connect and synchronize to continue.');
  }
  elapsed(now: number): number { return this.active ? Math.max(0, now - this.started) : this.result?.duration ?? 0; }
  inspectionElapsed(now: number): number { return this.phase === 'ready' && this.inspectionStarted !== null ? Math.max(0, now - this.inspectionStarted) : 0; }
}
