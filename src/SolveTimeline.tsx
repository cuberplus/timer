import { useEffect, useRef, useState } from 'react';
import type { Solve } from './engine';
import type { Cube } from './puzzle';
import { analyzeCFOP, CFOP_STEPS, cfopTiming } from './cfop';
import { formatTime } from './storage';

// Analyzer's Cross/OLL/PLL hues, with a shared violet family for F2L.
const colors = ['rgb(100, 200, 255)', 'rgb(156, 115, 220)', 'rgb(171, 136, 228)', 'rgb(185, 157, 236)', 'rgb(201, 180, 245)', 'rgb(255, 230, 150)', 'rgb(80, 220, 220)'];
type Annotation = { name: string; key: string; i: number; timing: ReturnType<typeof cfopTiming> | null; done: boolean };
export function SolveTimeline({ cube, solve, elapsed, precision }: { cube: Cube; solve: Solve; elapsed: number; precision: 2 | 3 }) {
  const trail = useRef<HTMLDivElement>(null), [width, setWidth] = useState(1000);
  useEffect(() => {
    if (!trail.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(trail.current); return () => observer.disconnect();
  }, []);
  const analysis = analyzeCFOP(solve, cube), time = Math.round(Math.max(solve.duration, elapsed));
  const steps = CFOP_STEPS.map((name, i) => ({ name: name.replace('Slot', 'Pair'), i, timing: i <= analysis.ends.length ? cfopTiming(solve, analysis.ends, i, time) : null }));
  const scale = solve.status === 'active' ? Math.max(10000, time * 1.2) : Math.max(1, time);
  const segments = steps.flatMap(({ name, i, timing }) => timing ? [
    { name, i, phase: 'recognition', start: timing.start, end: timing.start + timing.recognition },
    { name, i, phase: 'execution', start: timing.start + timing.recognition, end: timing.end },
  ] : []).filter(segment => segment.end > segment.start);
  const pairs = steps.slice(1, 5).flatMap(step => step.timing ? [step.timing] : []);
  const f2l = pairs.length ? {
    start: pairs[0].start, end: pairs[pairs.length - 1].end,
    time: pairs.reduce((sum, pair) => sum + pair.time, 0),
    recognition: pairs.reduce((sum, pair) => sum + pair.recognition, 0),
    execution: pairs.reduce((sum, pair) => sum + pair.execution, 0),
  } : null;
  const annotation = (i: number): Annotation => ({ ...steps[i], key: String(i), done: i < analysis.ends.length });
  const major = [annotation(0), { name: 'F2L', key: 'f2l', i: 1, timing: f2l, done: analysis.ends[4] !== undefined }, annotation(5), annotation(6)];
  function annotations(items: Annotation[], bottom = false) {
    const captions = items.map(item => ({
      ...item, caption: bottom ? item.name.replace('Pair ', '') : item.name,
      text: item.timing ? `${formatTime(item.timing.time, precision)}s` : '--',
    }));
    const labelWidth = Math.max(64, ...captions.map(item => (item.caption.length + item.text.length + 1) * 7 + 12)), area = Math.max(width, labelWidth);
    const rows = Math.ceil(items.length / Math.max(1, Math.floor(area / (labelWidth + 8)))), height = rows * 24 + 12;
    const labels = captions.map((item, index) => ({
      ...item, row: index % rows, anchor: item.timing ? (item.timing.start + item.timing.end) / 2 / scale * area : (index + 0.5) / items.length * area, position: 0,
    }));
    // Spread crowded labels without changing the time positions their leaders point to.
    for (let row = 0; row < rows; row++) {
      const rowLabels = labels.filter(label => label.row === row); let edge = labelWidth / 2;
      for (const label of rowLabels) { label.position = Math.max(label.anchor, edge); edge = label.position + labelWidth + 8; }
      edge = area - labelWidth / 2;
      for (const label of [...rowLabels].reverse()) { label.position = Math.min(label.position, edge); edge = label.position - labelWidth - 8; }
    }
    return <div className={`trail-labels${bottom ? ' trail-labels-bottom' : ''}`} role="group" aria-label={bottom ? 'F2L sub-times' : 'CFOP steps'} style={{ height }}>
      <svg aria-hidden="true" viewBox={`0 0 ${area} ${height}`} preserveAspectRatio="none">
        {labels.filter(label => label.timing).map(({ key, i, row, anchor, position }) => <line key={key} x1={position} y1={bottom ? row * 24 + 12 : (row + 1) * 24} x2={anchor} y2={bottom ? 0 : height} stroke={colors[i]} />)}
      </svg>
      {labels.map(({ key, name, caption, i, timing, done, text, row, position }) => <span key={key} className="trail-duration" data-step={key} data-duration={timing?.time} data-status={!timing ? 'unreached' : done ? 'done' : 'pending'} role="img" aria-label={`${name}: ${text} (${!timing ? 'not reached' : done ? 'complete' : 'in progress'})`} title={timing ? `${name}: ${text}; ${formatTime(timing.recognition, precision)}s recognition / ${formatTime(timing.execution, precision)}s execution` : `${name}: not reached`} style={{ left: `${position / area * 100}%`, top: row * 24 + (bottom ? 12 : 0), width: labelWidth, [bottom ? 'borderTopColor' : 'borderBottomColor']: colors[i] }}><strong>{caption}</strong> {text}</span>)}
    </div>;
  }
  return <div className="mt-3 mb-3" role="group" aria-label="Solve timeline">
    {annotations(major)}
    <div className="solve-trail" ref={trail}>
      {segments.map(({ name, i, phase, start, end }) => <span key={`${i}-${phase}`} className={`trail-segment ${phase}`} data-step={i} data-phase={phase} data-start={start} data-end={end} role="img" aria-label={`${name} ${phase}: ${formatTime(end - start, precision)}s`} title={`${name} ${phase}: ${formatTime(end - start, precision)}s`} style={{ left: `${start / scale * 100}%`, width: `${(end - start) / scale * 100}%`, backgroundColor: colors[i] }} />)}
      <span className="trail-tip" aria-hidden="true" style={{ left: `${time / scale * 100}%` }} />
    </div>
    {annotations([1, 2, 3, 4].map(annotation), true)}
    <div className="d-flex justify-content-between small text-secondary"><span>0s</span><span>{formatTime(scale, precision)}s</span></div>
  </div>;
}
