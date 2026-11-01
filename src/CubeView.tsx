import { useEffect, useRef } from 'react';
import { Alg, Move } from 'cubing/alg';
import { TwistyPlayer, type ExperimentalMillisecondTimestamp } from 'cubing/twisty';
import { Cube } from './puzzle';

interface Animation {
  cube: Cube; moves: readonly string[]; length: number;
  cursor: number; target: number; speed: number; time: number; frame: number;
}
const timestamp = (position: number) => position * 1000 as ExperimentalMillisecondTimestamp;

export function CubeView({ cube, facelets, moves, position = moves.length, speed = 1, animateSeeks = false }: {
  cube: Cube; facelets: string; moves: readonly string[]; position?: number; speed?: number; animateSeeks?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<TwistyPlayer | null>(null);
  const animation = useRef<Animation | null>(null);
  const length = moves.length;
  useEffect(() => {
    const element = new TwistyPlayer({ puzzle: '3x3x3', visualization: '3D', background: 'none', controlPanel: 'none', hintFacelets: 'none' });
    element.style.width = '100%';
    element.style.height = '280px';
    container.current?.appendChild(element);
    player.current = element;
    return () => {
      if (animation.current) cancelAnimationFrame(animation.current.frame);
      animation.current = null; element.pause(); element.remove(); player.current = null;
    };
  }, []);
  useEffect(() => {
    const element = player.current;
    if (!element) return;
    let state = animation.current;
    if (!state || state.cube !== cube || state.moves !== moves) {
      if (state) cancelAnimationFrame(state.frame);
      const prefix = new Alg(moves.slice(0, position).join(' '));
      element.experimentalModel.setupTransformation.set(cube.parse(facelets).applyAlg(prefix.invert()).experimentalToTransformation());
      state = { cube, moves, length: -1, cursor: position, target: position, speed, time: 0, frame: 0 };
      animation.current = state;
    }
    if (state.length !== length) {
      const leaves = moves.map(move => new Move(move));
      element.alg = new Alg(leaves);
      // Explicit, non-overlapping intervals keep repeated and opposite-face turns separate.
      element.experimentalModel.animationTimelineLeavesRequest.set(leaves.map((animLeaf, index) => ({
        animLeaf, start: timestamp(index), end: timestamp(index + 1),
      })));
      state.length = length;
    }
    if (!animateSeeks && Math.abs(position - state.target) > 1) {
      cancelAnimationFrame(state.frame); state.frame = 0; state.cursor = position;
    }
    state.target = position; state.speed = speed;
    element.timestamp = timestamp(state.cursor);
    if (state.frame || state.cursor === state.target) return;
    const active = state;
    active.time = performance.now();
    const tick = (now: number) => {
      // A stalled/background frame must not skip an entire batch of individual turns.
      const distance = Math.min(0.95, Math.max(0, now - active.time) * active.speed / 100);
      active.time = now;
      active.cursor += Math.sign(active.target - active.cursor) * Math.min(Math.abs(active.target - active.cursor), distance);
      element.timestamp = timestamp(active.cursor);
      active.frame = active.cursor === active.target ? 0 : requestAnimationFrame(tick);
    };
    active.frame = requestAnimationFrame(tick);
  }, [cube, facelets, moves, length, position, speed, animateSeeks]);
  return <div ref={container} role="img" aria-label="Live 3x3 cube state" />;
}
