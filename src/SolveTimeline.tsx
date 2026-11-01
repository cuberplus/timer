import { useEffect, useRef, useState } from 'react';
import type { Solve } from './engine';
import type { Cube } from './puzzle';
import { analyzeCFOP, CFOP_STEPS, cfopTiming } from './cfop';
import { formatTime } from './storage';

// Analyzer's Cross/OLL/PLL hues, with a shared violet family for F2L.
const colors = ['rgb(100, 200, 255)', 'rgb(156, 115, 220)', 'rgb(171, 136, 228)', 'rgb(185, 157, 236)', 'rgb(201, 180, 245)', 'rgb(255, 230, 150)', 'rgb(80, 220, 220)'];
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
  const reached = steps.flatMap(step => step.timing ? [{ ...step, timing: step.timing, text: `${formatTime(step.timing.time, precision)}s` }] : []);
  const labelWidth = Math.max(64, ...reached.map(step => step.text.length * 7 + 12)), area = Math.max(width, labelWidth);
  const rows = Math.ceil(reached.length / Math.max(1, Math.floor(area / (labelWidth + 8)))), height = rows * 24 + 12;
  const labels = reached.map((step, index) => ({ ...step, row: index % rows, anchor: (step.timing.start + step.timing.end) / 2 / scale * area, position: 0 }));
  // Spread crowded labels without changing the time positions their leaders point to.
  for (let row = 0; row < rows; row++) {
    const items = labels.filter(label => label.row === row); let edge = labelWidth / 2;
    for (const label of items) { label.position = Math.max(label.anchor, edge); edge = label.position + labelWidth + 8; }
    edge = area - labelWidth / 2;
    for (const label of [...items].reverse()) { label.position = Math.min(label.position, edge); edge = label.position - labelWidth - 8; }
  }
  return <div className="mt-3 mb-3" role="group" aria-label="Solve timeline">
    <div className="trail-labels" role="group" aria-label="CFOP steps" style={{ height }}>
      <svg aria-hidden="true" viewBox={`0 0 ${area} ${height}`} preserveAspectRatio="none">
        {labels.map(({ i, row, anchor, position }) => <line key={i} x1={position} y1={(row + 1) * 24} x2={anchor} y2={height} stroke={colors[i]} />)}
      </svg>
      {labels.map(({ name, i, timing, text, row, position }) => <span key={i} className="trail-duration" data-step={i} data-duration={timing.time} data-status={i < analysis.ends.length ? 'done' : 'pending'} role="img" aria-label={`${name}: ${text} (${i < analysis.ends.length ? 'complete' : 'in progress'})`} title={`${name}: ${text}; ${formatTime(timing.recognition, precision)}s recognition / ${formatTime(timing.execution, precision)}s execution`} style={{ left: `${position / area * 100}%`, top: row * 24, width: labelWidth, borderBottomColor: colors[i] }}>{text}</span>)}
    </div>
    <div className="solve-trail" ref={trail}>
      {segments.map(({ name, i, phase, start, end }) => <span key={`${i}-${phase}`} className={`trail-segment ${phase}`} data-step={i} data-phase={phase} data-start={start} data-end={end} role="img" aria-label={`${name} ${phase}: ${formatTime(end - start, precision)}s`} title={`${name} ${phase}: ${formatTime(end - start, precision)}s`} style={{ left: `${start / scale * 100}%`, width: `${(end - start) / scale * 100}%`, backgroundColor: colors[i] }} />)}
      <span className="trail-tip" aria-hidden="true" style={{ left: `${time / scale * 100}%` }} />
    </div>
    <div className="d-flex justify-content-between small text-secondary"><span>0s</span><span>{formatTime(scale, precision)}s</span></div>
  </div>;
}
