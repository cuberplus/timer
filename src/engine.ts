import type { KPattern } from 'cubing/kpuzzle';
import { Cube, inverse, isMove, movesOf } from './puzzle';

export type Phase = 'disconnected' | 'synchronizing' | 'scrambling' | 'ready' | 'solving' | 'finished' | 'recovery';
export interface Turn {
  move: string;
  hostTime: number;
  localTimestamp: number | null;
  cubeTimestamp: number | null;
  serial?: number;
}
export interface RecordedTurn extends Turn { elapsed: number }
export interface Orientation {
  elapsed: number;
  quaternion: { x: number; y: number; z: number; w: number };
}
export interface Solve {
  version: 1;
  id: string;
  session: string;
  createdAt: string;
  device: string;
  scramble: string;
  startFacelets: string;
  duration: number;
  status: 'active' | 'complete' | 'incomplete';
  reason: string;
  timingBasis: 'host' | 'device-fit';
  moves: RecordedTurn[];
  orientations: Orientation[];
}

// GAN and MoYu history windows use circular 8-bit turn counters.
const serialDistance = (next: number, previous: number): number => (next - previous) & 0xff;

export function finalizeTiming(moves: RecordedTurn[]): { duration: number; timingBasis: Solve['timingBasis'] } {
  const host = moves.length ? moves[moves.length - 1].elapsed : 0;
  if (moves.length < 5 || moves.some(m => m.cubeTimestamp === null || m.localTimestamp === null)) return { duration: host, timingBasis: 'host' };
  const first = moves[0];
  const xs = moves.map(m => m.cubeTimestamp! - first.cubeTimestamp!);
  const ys = moves.map(m => m.localTimestamp! - first.localTimestamp!);
  if (xs.some((x, i) => i > 0 && x <= xs[i - 1]) || ys.some((y, i) => i > 0 && y < ys[i - 1])) return { duration: host, timingBasis: 'host' };
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const variance = xs.reduce((a, x) => a + (x - meanX) ** 2, 0);
  const slope = xs.reduce((a, x, i) => a + (x - meanX) * (ys[i] - meanY), 0) / variance;
  const residual = Math.sqrt(xs.reduce((a, x, i) => a + (ys[i] - (meanY + slope * (x - meanX))) ** 2, 0) / xs.length);
  if (!Number.isFinite(slope) || slope < 0.8 || slope > 1.2 || residual > 30) return { duration: host, timingBasis: 'host' };
  return { duration: Math.max(0, slope * xs[xs.length - 1]), timingBasis: 'device-fit' };
}

export class TimerEngine {
  phase: Phase = 'disconnected';
  pattern: KPattern;
  scramble = '';
  progress = 0;
  instructions: string[] = [];
  recovery: string[] = [];
  message = 'Connect your cube to begin.';
  device = '';
  session = 'Default';
  active: Solve | null = null;
  result: Solve | null = null;
  lastSerial: number | undefined;
  private checkpoints: KPattern[] = [];
  private partial: string[] = [];
  private started = 0;
  constructor(readonly cube: Cube, private readonly record: (solve: Solve) => void, private readonly changed: () => void) {
    this.pattern = cube.solved();
  }
  get facelets(): string { return this.cube.facelets(this.pattern); }
  get nextMove(): string {
    if (!this.recovery.length && this.partial.length === 1 && this.instructions[this.progress]?.includes('2')) return this.partial[0];
    return this.recovery[0] ?? this.instructions[this.progress] ?? '';
  }
  connect(device: string): void {
    this.interrupt('Connection changed.');
    this.device = device;
    this.phase = 'synchronizing';
    this.lastSerial = undefined;
    this.message = 'Reading cube state. If unavailable, physically solve and confirm calibration.';
    this.changed();
  }
  synchronize(facelets: string, serial?: number): void {
    const pattern = this.cube.parse(facelets);
    this.interrupt('Cube state was resynchronized.');
    this.pattern = pattern;
    this.lastSerial = serial;
    this.phase = 'synchronizing';
    this.message = 'State synchronized. Preparing scramble guidance.';
    this.changed();
  }
  prepare(scramble: string, setup: string[] = []): void {
    const moves = movesOf(scramble);
    if (!moves.length || [...setup, ...moves].some(move => !isMove(move))) throw new Error('Invalid scramble or setup moves.');
    if (this.phase === 'disconnected' || this.phase === 'solving') throw new Error('Cannot prepare a scramble in this state.');
    const checkpoints = [this.pattern];
    [...setup, ...moves].forEach(move => checkpoints.push(checkpoints[checkpoints.length - 1].applyMove(move)));
    if (!this.cube.equals(checkpoints[setup.length], this.cube.solved())) throw new Error('Setup does not solve the current cube.');
    this.scramble = scramble;
    this.instructions = [...setup, ...moves];
    this.checkpoints = checkpoints;
    this.progress = 0;
    this.partial = [];
    this.recovery = [];
    this.result = null;
    this.phase = 'scrambling';
    this.message = setup.length ? 'Follow setup moves to solve the cube, then scramble.' : 'Follow the highlighted scramble move.';
    this.changed();
  }
  snapshot(facelets: string, serial?: number): void {
    this.cube.parse(facelets);
    if (this.phase === 'synchronizing') { this.synchronize(facelets, serial); return; }
    // A stale history snapshot must not roll back newer recorded turns.
    const distance = serial !== undefined && this.lastSerial !== undefined ? serialDistance(serial, this.lastSerial) : 0;
    if (distance >= 240) return;
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
    if (turn.serial !== undefined) this.lastSerial = turn.serial;
    if (this.phase === 'ready') {
      this.started = turn.hostTime;
      this.active = {
        version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), session: this.session,
        device: this.device, scramble: this.scramble, startFacelets: this.facelets,
        duration: 0, status: 'active', reason: '', timingBasis: 'host', moves: [], orientations: [],
      };
      this.phase = 'solving';
    }
    this.pattern = this.pattern.applyMove(turn.move);
    if (this.phase === 'solving' && this.active) {
      this.active.moves.push({ ...turn, elapsed: Math.max(0, turn.hostTime - this.started) });
      this.active.duration = this.active.moves[this.active.moves.length - 1].elapsed;
      if (this.cube.isSolved(this.pattern)) {
        Object.assign(this.active, finalizeTiming(this.active.moves), { status: 'complete' });
        this.result = this.active;
        this.active = null;
        this.phase = 'finished';
        this.message = 'Solved! Your full move timeline is recorded.';
        this.record(this.result);
      } else this.record(this.active);
    } else if (this.phase === 'scrambling') this.guide(turn.move);
    this.changed();
  }
  private guide(move: string): void {
    const target = this.checkpoints[this.checkpoints.length - 1];
    if (this.cube.equals(this.pattern, target)) {
      this.progress = this.instructions.length;
      this.partial = [];
      this.recovery = [];
      this.phase = 'ready';
      this.message = 'Scramble complete. Your next face turn starts the timer.';
      return;
    }
    const current = this.checkpoints[this.progress];
    const next = this.checkpoints[this.progress + 1];
    if (next && this.cube.equals(this.pattern, next)) {
      this.progress++;
      this.partial = [];
      this.recovery = [];
    } else if (this.cube.equals(this.pattern, current)) {
      this.partial = [];
      this.recovery = [];
    } else {
      if (this.recovery.length && move === this.recovery[0]) {
        this.recovery.shift();
        this.partial.pop();
      } else this.partial.push(move);
      const expected = this.instructions[this.progress];
      const halfTurn = expected?.includes('2') && this.partial.length === 1 && move[0] === expected[0] && !move.includes('2');
      this.recovery = halfTurn ? [] : [...this.partial].reverse().map(inverse);
      if (halfTurn) {
        this.message = `Turn ${move} once more to complete ${expected}.`;
        return;
      }
    }
    this.message = this.recovery.length ? 'Wrong turn. Follow correction moves back to the checkpoint.' : 'Follow the highlighted move.';
  }
  gyro(quaternion: Orientation['quaternion'], hostTime: number): void {
    if (!this.active) return;
    this.active.orientations.push({ elapsed: Math.max(0, hostTime - this.started), quaternion });
  }
  interrupt(reason: string): void {
    if (!this.active) return;
    this.active.status = 'incomplete';
    this.active.reason = reason;
    this.result = this.active;
    this.record(this.active);
    this.active = null;
  }
  fail(reason: string): void {
    if (this.phase === 'finished' && this.result?.status === 'complete') {
      this.result.status = 'incomplete';
      this.result.reason = reason;
      this.record(this.result);
    }
    this.interrupt(reason);
    this.phase = 'recovery';
    this.message = reason;
    this.changed();
  }
  disconnect(): void {
    this.interrupt('Cube disconnected during the solve.');
    this.phase = 'disconnected';
    this.message = 'Cube disconnected. Connect and synchronize to continue.';
    this.changed();
  }
  elapsed(now: number): number { return this.active ? Math.max(0, now - this.started) : this.result?.duration ?? 0; }
}
