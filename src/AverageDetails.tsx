import { useEffect, useMemo, useRef } from 'react';
import { solveTime, type Solve } from './engine';
import { averageDetails, formatTime, numberedSolves } from './storage';

export function AverageDetails({ details, history, precision, view, close }: {
  details: NonNullable<ReturnType<typeof averageDetails>>;
  history: Solve[];
  precision: 2 | 3;
  view: (solve: Solve) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const dismiss = () => { dialog.current?.close(); close(); };
  const trim = details.solves.filter(item => item.trimmed === 'best').length;
  const numbers = useMemo(() => new Map(numberedSolves(history.filter(solve => solve.session === details.solves[0].solve.session))
    .map(({ solve, number }) => [solve.id, number])), [history, details]);
  const rows = useMemo(() => details.solves.map(({ solve, trimmed }) => {
    const number = numbers.get(solve.id), time = `${formatTime(solveTime(solve), precision)}s`;
    return <tr key={solve.id}>
      <th scope="row">{number}</th>
      <td>{trimmed ? <s className={`average-trimmed-${trimmed}`} title={`Excluded ${trimmed}`} aria-label={`Excluded ${trimmed}: ${time}`}>({time})</s> : time}
        {solve.penalty === 2000 && <span className="badge text-bg-warning ms-1">+2</span>}
      </td>
      <td><button className="btn btn-sm btn-outline-secondary" aria-label={`View average solve ${number}`} onClick={() => view(solve)}>View</button></td>
    </tr>;
  }), [details, numbers, precision, view]);
  return <dialog ref={dialog} className="panel average-dialog" aria-labelledby="average-title" onCancel={event => { event.preventDefault(); dismiss(); }}>
    <div className="d-flex justify-content-between align-items-center gap-3">
      <h2 id="average-title">Ao{details.solves.length}: {formatTime(details.time, precision)}s</h2>
      <button autoFocus className="btn btn-outline-secondary" onClick={dismiss}>Close average</button>
    </div>
    <p className="small text-secondary">Oldest to newest. Excludes the {trim} fastest and {trim} slowest solves; averages the remaining {details.solves.length - 2 * trim}.</p>
    <div className="table-responsive">
      <table className="table table-sm align-middle" aria-label="Average solves">
        <thead><tr><th scope="col">Solve</th><th scope="col">Time</th><th scope="col">View</th></tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  </dialog>;
}
