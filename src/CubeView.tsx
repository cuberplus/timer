import { useEffect, useRef } from 'react';
import { TwistyPlayer } from 'cubing/twisty';
import { Cube } from './puzzle';

export function CubeView({ cube, facelets }: { cube: Cube; facelets: string }) {
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<TwistyPlayer | null>(null);
  useEffect(() => {
    const element = new TwistyPlayer({ puzzle: '3x3x3', visualization: '3D', background: 'none', controlPanel: 'none' });
    element.style.width = '100%';
    element.style.height = '280px';
    container.current?.appendChild(element);
    player.current = element;
    return () => { element.remove(); player.current = null; };
  }, []);
  useEffect(() => {
    if (player.current) player.current.experimentalModel.setupTransformation.set(cube.parse(facelets).experimentalToTransformation());
  }, [cube, facelets]);
  return <div ref={container} role="img" aria-label="Live 3x3 cube state" />;
}
