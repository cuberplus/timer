import 'fake-indexeddb/auto';
import { TimerEngine, type Solve } from '../engine';
import { Cube, loadCube, SOLVED } from '../puzzle';
import { average, averageDetails, backupJSON, cubeastCSV, newPersonalBests, personalBestNotifications, readSolves, saveSolves, sessionStats, turns, validateBackup } from '../storage';

let cube: Cube;
beforeAll(async () => { cube = await loadCube(); });

function sample(): Solve {
  const timer = new TimerEngine(cube, () => {}, () => {});
  timer.connect('Test cube'); timer.synchronize(SOLVED); timer.prepare('R U2');
  ['R', 'U2', 'U2', "R'"].forEach((move, i) => timer.turn({ move, hostTime: i * 100, localTimestamp: i * 100, cubeTimestamp: null }));
  return timer.result!;
}

test('persists complete records and merges by id', async () => {
  const solve = sample();
  await saveSolves([solve]);
  await saveSolves([{ ...solve, session: 'Updated' }]);
  const items = await readSolves();
  expect(items.filter(item => item.id === solve.id)).toHaveLength(1);
  expect(items.find(item => item.id === solve.id)?.session).toBe('Updated');
  expect(items.find(item => item.id === solve.id)?.inspection).toBe(100);
});

test('JSON backup preserves every raw timing and turn', () => {
  const solve = sample();
  expect(validateBackup(backupJSON([solve]), cube)).toEqual([solve]);
  expect(turns(solve)).toBe(3);
});

test('penalties round-trip through local storage and backups without changing raw timing', async () => {
  const solve: Solve = { ...sample(), penalty: 2000, penaltyReason: 'over-turn' };
  await saveSolves([solve]);
  const restored = (await readSolves()).find(item => item.id === solve.id)!;
  expect(validateBackup(backupJSON([restored]), cube)).toEqual([solve]);
});

test('legacy penalties and DNFs receive reasons, including recovered active attempts', () => {
  const seed = sample();
  const restored = validateBackup(backupJSON([
    { ...seed, id: 'legacy-plus-two', penalty: 2000 },
    { ...seed, id: 'legacy-abort', status: 'incomplete', reason: 'Solve aborted by user.' },
    { ...seed, id: 'legacy-interrupt', status: 'incomplete', reason: 'Cube disconnected.' },
    { ...seed, id: 'recovered', status: 'active' },
  ]), cube);
  expect(restored[0].penaltyReason).toBe('over-turn');
  expect(restored.slice(1).map(solve => solve.dnfReason)).toEqual(['solve aborted', 'solve interrupted', 'solve interrupted']);
  expect(validateBackup(backupJSON(restored), cube)).toEqual(restored);
});

test.each([
  { penalty: 2000, penaltyReason: 'invalid' },
  { penaltyReason: 'over-turn' },
  { status: 'incomplete', dnfReason: 'invalid' },
  { dnfReason: 'solve aborted' },
])('rejects invalid penalty reason fields %j', fields => {
  expect(() => validateBackup(JSON.stringify({ format: 'timer-v1', solves: [{ ...sample(), ...fields }] }), cube)).toThrow('Invalid solve record');
});

test.each([-2000, 0, 2, 4000, null, '2000'])('rejects invalid penalty %s in backups', penalty => {
  expect(() => validateBackup(JSON.stringify({ format: 'timer-v1', solves: [{ ...sample(), penalty }] }), cube)).toThrow('Invalid solve record');
});

test('statistics and CSV totals include +2 while retaining raw solving and replay times', () => {
  const solve: Solve = { ...sample(), duration: 3000, penalty: 2000 };
  expect(sessionStats([solve])[0]).toEqual({ name: 'Single', current: 5000, best: 5000 });
  expect(average(Array.from({ length: 5 }, () => solve), 5)).toBe(5000);
  const [header, line] = cubeastCSV([solve], cube).split('\r\n');
  const cells = line.split(',');
  const row = Object.fromEntries(header.split(',').map((column, i) => [column, cells[i]]));
  expect(row).toMatchObject({ time: '5000', timer_time: '3000', solving_time: '3000', one_turn_away_two_second_penalty: 'true', dnf: 'false' });
  expect(solve.duration).toBe(3000);
});

test('older backups retain their IDs and leave missing inspection time unrecorded', () => {
  const solve = sample();
  delete solve.inspection;
  expect(validateBackup(backupJSON([solve]), cube)).toEqual([solve]);
  const [header, row] = cubeastCSV([solve], cube).split('\r\n');
  expect(row.split(',')[header.split(',').indexOf('inspection_time')]).toBe('');
});

test.each([-1, null, 'invalid'])('rejects invalid inspection time %s in backups', inspection => {
  const json = JSON.stringify({ format: 'timer-v1', solves: [{ ...sample(), inspection }] });
  expect(() => validateBackup(json, cube)).toThrow('Invalid solve record');
});

test('recovers active recordings as incomplete', () => {
  const solve = { ...sample(), status: 'active' as const };
  expect(validateBackup(backupJSON([solve]), cube)[0].status).toBe('incomplete');
});

test.each(['null', '{}', '{"format":"timer-v1","solves":[null]}', '{"format":"timer-v1","solves":{}}'])('rejects malformed backup %s', json => {
  expect(() => validateBackup(json, cube)).toThrow();
});

test('rejects invalid timelines, false completion, duplicate ids and scramble mismatch', () => {
  const solve = sample();
  expect(() => validateBackup(backupJSON([{ ...solve, moves: [{ ...solve.moves[0], elapsed: -1 }] }]), cube)).toThrow();
  expect(() => validateBackup(backupJSON([{ ...solve, moves: solve.moves.slice(0, 1) }]), cube)).toThrow('does not end solved');
  expect(() => validateBackup(backupJSON([solve, solve]), cube)).toThrow();
  expect(() => validateBackup(backupJSON([{ ...solve, scramble: 'F' }]), cube)).toThrow('start');
});

test('averages trim high/low, include DNFs and exclude active attempts', () => {
  const solve = sample();
  const items = [1, 2, 3, 4, 100].map(n => ({ ...solve, duration: n * 1000 }));
  expect(average([{ ...solve, status: 'active' }, ...items], 5)).toBe(3000);
  expect(average([{ ...solve, status: 'incomplete' }, ...items], 5)).toBe(3000);
  expect(average([{ ...solve, status: 'incomplete' }, ...items.slice().reverse()], 5)).toBeCloseTo(107000 / 3);
  expect(average(items, 12)).toBeNull();
});

test.each([5, 12, 100, 1000])('Ao%s trims DNFs as worst and becomes DNF above the trim allowance', count => {
  const seed = sample(), trim = Math.ceil(count / 20);
  for (const dnfs of [trim, trim + 1, count]) {
    const solves = Array.from({ length: count }, (_, i) => ({
      ...seed, id: String(i), duration: 10000, status: i < dnfs ? 'incomplete' as const : 'complete' as const,
    }));
    const expected = dnfs <= trim ? 10000 : 'DNF';
    expect(average(solves, count)).toBe(expected);
    expect(sessionStats(solves).find(stat => stat.name === `Ao${count}`)).toEqual({ name: `Ao${count}`, current: expected, best: expected });
    const details = averageDetails(solves, count)!;
    expect(details.time).toBe(expected);
    expect(details.solves).toHaveLength(count);
    expect(details.solves.filter(item => item.trimmed === 'worst')).toHaveLength(trim);
    expect(details.solves.filter(item => item.trimmed === 'worst').every(item => item.solve.status === 'incomplete')).toBe(true);
    expect(details.solves.filter(item => item.trimmed === null).some(item => item.solve.status === 'incomplete')).toBe(dnfs > trim);
  }
});

test.each([5, 12, 100, 1000])('rolling Ao%s recovers between DNF and valid windows and selects the correct best details', count => {
  const seed = sample(), trim = Math.ceil(count / 20);
  const solves = Array.from({ length: count * 3 + 13 }, (_, i) => ({
    ...seed, id: String(i), duration: 10000 + (i * 13 % 23) * 100,
    status: i % (count + 7) < trim + 2 ? 'incomplete' as const : 'complete' as const,
  }));
  const means = Array.from({ length: solves.length - count + 1 }, (_, start) => {
    const kept = solves.slice(start, start + count).map(solve => solve.status === 'incomplete' ? Infinity : solve.duration)
      .sort((a, b) => a - b).slice(trim, -trim);
    return kept.reduce((sum, value) => sum + value, 0) / kept.length;
  });
  const best = Math.min(...means), stats = sessionStats(solves).find(stat => stat.name === `Ao${count}`)!;
  expect(means[0]).toBe(Infinity);
  expect(Number.isFinite(best)).toBe(true);
  expect(stats.current).toBe('DNF');
  expect(stats.best).toBeCloseTo(best, 7);
  const details = averageDetails(solves, count, true)!;
  expect(details.time).toBeCloseTo(best, 7);
  expect(details.solves.map(item => item.solve.id)).toEqual(solves.slice(means.indexOf(best), means.indexOf(best) + count).reverse().map(solve => solve.id));
  const reversed = sessionStats(solves.slice().reverse()).find(stat => stat.name === `Ao${count}`)!;
  expect(reversed.best).toBeCloseTo(best, 7);
  const current = average(solves.slice().reverse(), count);
  if (Number.isFinite(means.at(-1)!)) expect(current).toBeCloseTo(means.at(-1)!, 7);
  else expect(current).toBe('DNF');
});

test('PB checks include DNFs in new windows, never celebrate DNF averages, and accept finite averages after DNF records', () => {
  const seed = sample();
  const previous = [12000, 14000, 1, 16000, 1].map((duration, i) => ({
    ...seed, id: `previous-${i}`, duration, status: duration === 1 ? 'incomplete' as const : 'complete' as const,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 10 - i)).toISOString(),
  }));
  expect(newPersonalBests(previous, { ...seed, duration: 10000 })).toEqual([
    { name: 'Single', time: 10000 }, { name: 'Ao5', time: 14000 },
  ]);
  expect(newPersonalBests(previous, { ...seed, status: 'incomplete' })).toEqual([]);
  expect(newPersonalBests(previous.filter(solve => solve.status === 'complete'), { ...seed, duration: 10000 })).toEqual([{ name: 'Single', time: 10000 }]);
  const four = [10000, 12000, 14000, 16000].map((duration, i) => ({ ...seed, id: `previous-${i}`, duration }));
  expect(newPersonalBests(four, { ...seed, status: 'incomplete' })).toEqual([{ name: 'Ao5', time: 14000 }]);
});

test('identifies every single and average PB improved by the same solve', () => {
  const seed = sample();
  const previous = [12, 14, 16, 18, 20].map((seconds, i) => ({
    ...seed, id: `previous-${i}`, duration: seconds * 1000, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 20 - i)).toISOString(),
  }));
  expect(newPersonalBests(previous, { ...seed, duration: 10000 })).toEqual([
    { name: 'Single', time: 10000 }, { name: 'Ao5', time: 14000 },
  ]);
});

test.each([5, 12, 100, 1000])('celebrates the first available Ao%s without re-celebrating tied smaller records', count => {
  const seed = sample();
  const previous = Array.from({ length: count - 1 }, (_, i) => ({ ...seed, id: `previous-${i}`, duration: 10000 }));
  expect(newPersonalBests(previous, { ...seed, duration: 10000 })).toEqual([{ name: `Ao${count}`, time: 10000 }]);
});

test('PB detection respects session boundaries, penalties, ties and incomplete attempts', () => {
  const seed = sample(), previous = [{ ...seed, id: 'previous', duration: 10000 }];
  expect(newPersonalBests([], seed)).toEqual([{ name: 'Single', time: seed.duration }]);
  expect(newPersonalBests(previous, { ...seed, duration: 10000 })).toEqual([]);
  expect(newPersonalBests(previous, { ...seed, duration: 9000, penalty: 2000 })).toEqual([]);
  expect(newPersonalBests(previous, { ...seed, duration: 1, status: 'incomplete' })).toEqual([]);
  expect(newPersonalBests(previous, { ...seed, session: 'Other', duration: 20000 })).toEqual([{ name: 'Single', time: 20000 }]);
});

test('a slower newest Ao12 does not re-celebrate an unchanged historical PB due to rounding drift', () => {
  const seed = sample();
  const previous = [11061.2, 11049.64, 12629.46, 12904.71, 13730.08, 11337.38, 12487.66, 12645.04, 12788.3, 13350.35, 11119.56, 11000]
    .map((duration, i) => ({ ...seed, id: `previous-${i}`, duration, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 12 - i)).toISOString() }));
  const solve = { ...seed, duration: 15000 };
  expect(average(previous, 12)).toBeCloseTo(12137.33, 7);
  expect(average([solve, ...previous], 12)).toBeCloseTo(12405.374, 7);
  expect(newPersonalBests(previous, solve)).toEqual([]);
});

test('newest-window PB comparison ignores floating-point ties but preserves real fractional improvements', () => {
  const seed = sample();
  const previous = Array.from({ length: 12 }, (_, i) => ({ ...seed, id: `previous-${i}`, duration: 12000.1 }));
  expect(newPersonalBests(previous, { ...seed, duration: 12000.1 - 1e-9 })).toEqual([]);
  const varied = previous.map((solve, i) => ({ ...solve, duration: i === 0 ? 11000 : i === 1 ? 13000 : solve.duration }));
  const improved = newPersonalBests(varied, { ...seed, duration: 12000.09 });
  expect(improved.map(record => record.name)).toEqual(['Ao5', 'Ao12']);
  expect(improved.find(record => record.name === 'Ao12')!.time).toBeCloseTo(12000.099, 7);
});

test('PB checks read older solve times only for previous records, not for the newest windows', () => {
  const seed = sample();
  const previous = Array.from({ length: 1200 }, (_, i) => ({
    ...seed, id: `previous-${i}`, duration: 10000, createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
  }));
  let reads = 0;
  Object.defineProperty(previous[0], 'duration', { get: () => { reads++; return 10000; } });
  expect(newPersonalBests(previous, { ...seed, duration: 9000 })).toEqual([{ name: 'Single', time: 9000 }]);
  expect(reads).toBe(1);
});

test('current average details do not read times outside the newest finished window', () => {
  const seed = sample(), older = { ...seed, id: 'older' };
  let reads = 0;
  Object.defineProperty(older, 'duration', { get: () => { reads++; return 1; } });
  const recent = Array.from({ length: 5 }, (_, i) => ({ ...seed, id: `recent-${i}`, duration: 10000 }));
  expect(averageDetails([{ ...seed, status: 'incomplete' }, ...recent, older], 5)!.time).toBe(10000);
  expect(reads).toBe(0);
});

test('average details select the current or best window and identify trimmed solves including penalties', () => {
  const seed = sample();
  const solves = [20000, 10000, 9000, 8000, 7000, 6000, 5000].map((duration, i) => ({ ...seed, id: String(i), duration }));
  const current = averageDetails([{ ...seed, status: 'active' }, ...solves], 5)!;
  expect(current.time).toBe(9000);
  expect(current.solves.map(item => [item.solve.id, item.trimmed])).toEqual([
    ['4', 'best'], ['3', null], ['2', null], ['1', null], ['0', 'worst'],
  ]);
  const best = averageDetails(solves, 5, true)!;
  expect(best.time).toBe(7000);
  expect(best.solves.map(item => item.solve.id)).toEqual(['6', '5', '4', '3', '2']);
  const penalized = averageDetails([solves[0], solves[1], solves[2], solves[3], { ...solves[4], penalty: 2000 }], 5)!;
  expect(penalized.time).toBeCloseTo(28000 / 3, 7);
  expect(penalized.solves.find(item => item.trimmed === 'best')!.solve.id).toBe('3');
  expect(averageDetails(solves.slice(0, 4), 5)).toBeNull();
});

test.each([5, 12, 100, 1000])('Ao%s details exclude exactly five percent at each end, even when all solves tie', count => {
  const seed = sample();
  const solves = Array.from({ length: count }, (_, i) => ({ ...seed, id: String(i), duration: 10000 }));
  const details = averageDetails(solves, count, true)!;
  expect(details.solves).toHaveLength(count);
  expect(details.time).toBe(10000);
  for (const trimmed of ['best', 'worst']) expect(details.solves.filter(item => item.trimmed === trimmed)).toHaveLength(Math.ceil(count / 20));
  expect(details.solves.filter(item => item.trimmed === null)).toHaveLength(count - 2 * Math.ceil(count / 20));
});

test('every short PB is eligible, while each long-average PB is eligible only once per daily ledger', () => {
  const records = ['Single', 'Ao5', 'Ao12', 'Ao100', 'Ao1000'].map(name => ({ name, time: 10000 }));
  const shown = new Set<string>();
  expect(personalBestNotifications(records, shown)).toEqual(records);
  expect(personalBestNotifications(records, shown).map(record => record.name)).toEqual(['Single', 'Ao5', 'Ao12']);
  expect(personalBestNotifications(records, shown).map(record => record.name)).toEqual(['Single', 'Ao5', 'Ao12']);
  expect(personalBestNotifications(records, new Set(['Ao100'])).map(record => record.name)).toEqual(['Single', 'Ao5', 'Ao12', 'Ao1000']);
  expect(personalBestNotifications(records, new Set())).toEqual(records);
});

test('every long-average PB can be shown without losing the daily ledger when the option is turned off', () => {
  const records = ['Single', 'Ao5', 'Ao12', 'Ao100', 'Ao1000'].map(name => ({ name, time: 10000 }));
  const shown = new Set<string>();
  expect(personalBestNotifications(records, shown, true)).toEqual(records);
  expect(personalBestNotifications(records, shown, true)).toEqual(records);
  expect(personalBestNotifications(records, shown, false).map(record => record.name)).toEqual(['Single', 'Ao5', 'Ao12']);
});

test('current and best singles respect the latest attempt while averages exclude active recordings', () => {
  const solve = sample();
  const items = [10, 10, 10, 10, 10, 1, 1, 1, 1, 1].map(n => ({ ...solve, duration: n * 1000 }));
  const stats = sessionStats([{ ...solve, status: 'active' }, { ...solve, status: 'incomplete' }, ...items]);
  expect(stats[0]).toEqual({ name: 'Single', current: 'DNF', best: 1000 });
  expect(stats[1]).toEqual({ name: 'Ao5', current: 10000, best: 1000 });
  expect(stats.slice(2).every(stat => stat.current === null && stat.best === null)).toBe(true);
  expect(sessionStats([]).every(stat => stat.current === null && stat.best === null)).toBe(true);
});

test.each([100, 1000])('Ao%s trims five percent from both ends', count => {
  const solve = sample(), trim = count / 20;
  const durations = [...Array(trim).fill(0), ...Array(count - trim * 2).fill(2500), ...Array(trim).fill(1_000_000)] as number[];
  const stats = sessionStats(durations.map(duration => ({ ...solve, duration })));
  expect(stats.find(stat => stat.name === `Ao${count}`)).toEqual({ name: `Ao${count}`, current: 2500, best: 2500 });
  expect(average(durations.map(duration => ({ ...solve, duration })), count)).toBe(2500);
});

test.each([5, 12, 100, 1000])('best Ao%s matches all rolling windows, including duplicates and fractional timings', count => {
  const solve = sample(), durations = Array.from({ length: 1213 }, (_, i) => ((i * 7919) % 121) * 100 + 123.456);
  const trim = Math.ceil(count / 20);
  const means = Array.from({ length: durations.length - count + 1 }, (_, i) => {
    const middle = durations.slice(i, i + count).sort((a, b) => a - b).slice(trim, -trim);
    return middle.reduce((a, b) => a + b, 0) / middle.length;
  });
  const stats = sessionStats(durations.map(duration => ({ ...solve, duration }))).find(stat => stat.name === `Ao${count}`)!;
  expect(stats.current).toBeCloseTo(means[0], 7);
  expect(stats.best).toBeCloseTo(Math.min(...means), 7);
});

// Exact header from smartcubeanalyzer/public/demo/cfop-small.csv.
const cubeastHeader = 'id,date,dnf,time,solving_method,device_name,device_model,device_color_scheme,user,one_turn_away_two_second_penalty,inspection_two_second_penalty,inspection_time,timer_time,missing_turn,solution,timer,description,session_name,session_ruleset,scramble,scramble_provider,ruleset,share_views,share_likes,share_comments,analysis_version,solution_rotation,pickup_time,putdown_time,solving_time,slice_turns,face_turns,quarter_turns,turns_per_second,total_recognition_time,total_execution_time,turns_after_solution,steps_skipped,step_0_name,step_0_moves,step_0_recorded_moves,step_0_skipped,step_0_has_turns,step_0_time,step_0_recognition_time,step_0_execution_time,step_0_cumulative_time,step_0_slice_turns,step_0_face_turns,step_0_quarter_turns,step_0_turns_per_second,step_1_name,step_1_moves,step_1_recorded_moves,step_1_skipped,step_1_has_turns,step_1_time,step_1_recognition_time,step_1_execution_time,step_1_cumulative_time,step_1_slice_turns,step_1_face_turns,step_1_quarter_turns,step_1_turns_per_second,step_2_name,step_2_moves,step_2_recorded_moves,step_2_skipped,step_2_has_turns,step_2_time,step_2_recognition_time,step_2_execution_time,step_2_cumulative_time,step_2_slice_turns,step_2_face_turns,step_2_quarter_turns,step_2_turns_per_second,step_3_name,step_3_moves,step_3_recorded_moves,step_3_skipped,step_3_has_turns,step_3_time,step_3_recognition_time,step_3_execution_time,step_3_cumulative_time,step_3_slice_turns,step_3_face_turns,step_3_quarter_turns,step_3_turns_per_second,step_4_name,step_4_moves,step_4_recorded_moves,step_4_skipped,step_4_has_turns,step_4_time,step_4_recognition_time,step_4_execution_time,step_4_cumulative_time,step_4_slice_turns,step_4_face_turns,step_4_quarter_turns,step_4_turns_per_second,step_5_name,step_5_moves,step_5_recorded_moves,step_5_skipped,step_5_has_turns,step_5_time,step_5_recognition_time,step_5_execution_time,step_5_cumulative_time,step_5_slice_turns,step_5_face_turns,step_5_quarter_turns,step_5_turns_per_second,step_6_name,step_6_moves,step_6_recorded_moves,step_6_skipped,step_6_has_turns,step_6_time,step_6_recognition_time,step_6_execution_time,step_6_cumulative_time,step_6_slice_turns,step_6_face_turns,step_6_quarter_turns,step_6_turns_per_second,step_7_name,step_7_moves,step_7_recorded_moves,step_7_skipped,step_7_has_turns,step_7_time,step_7_recognition_time,step_7_execution_time,step_7_cumulative_time,step_7_slice_turns,step_7_face_turns,step_7_quarter_turns,step_7_turns_per_second,step_8_name,step_8_moves,step_8_recorded_moves,step_8_skipped,step_8_has_turns,step_8_time,step_8_recognition_time,step_8_execution_time,step_8_cumulative_time,step_8_slice_turns,step_8_face_turns,step_8_quarter_turns,step_8_turns_per_second,step_0_case,step_1_case,step_2_case,step_3_case,step_4_case,step_5_case,step_6_case,step_7_case,step_8_case';

test('Cubeast CSV matches the sample schema and records milliseconds, UTC dates, raw turns and session', () => {
  const solve = { ...sample(), createdAt: '2026-10-31T15:22:52.997Z' };
  solve.moves[1].elapsed = 1234.56;
  solve.duration = 1234.56;
  const [header, line, trailing] = cubeastCSV([solve], cube).split('\r\n');
  expect(header).toBe(cubeastHeader);
  expect(trailing).toBe('');
  const columns = header.split(',');
  const cells = line.split(',');
  expect(cells).toHaveLength(164);
  const row = Object.fromEntries(columns.map((column, i) => [column, cells[i]]));
  expect(row).toMatchObject({
    id: solve.id, date: '2026-10-31 15:22:52 UTC', dnf: 'false', time: '1235',
    timer_time: '1235', solving_time: '1235', solution: "U2[0] R'[1235]",
    device_name: 'Test cube', session_name: 'Default', scramble: 'R U2', timer: 'cube',
    face_turns: '2', slice_turns: '2', quarter_turns: '3', turns_per_second: '1.62',
  });
  expect(row).toMatchObject({
    solving_method: 'CFOP', step_0_name: 'Cross', step_0_moves: 'L2', step_0_recorded_moves: 'L2[0]',
    step_0_skipped: 'false', step_1_name: 'F2L Slot 1', step_1_skipped: 'true', step_5_name: 'OLL',
    step_6_name: 'PLL', step_6_moves: "U'", step_6_recorded_moves: "U'[1235]",
    step_6_time: '1235', step_6_cumulative_time: '1235', steps_skipped: '5',
  });
  expect(columns.filter(column => /^step_[78]_/.test(column) || column.endsWith('_case')).every(column => row[column] === '')).toBe(true);
  expect(row.inspection_time).toBe('100');
});

test('Cubeast CSV escapes commas, quotes and newlines without changing stored data', () => {
  const solve = { ...sample(), session: 'Practice, "fast"\r\ncubes', device: 'Cube, "test"', reason: 'Line 1\nLine 2' };
  const before = structuredClone(solve);
  const csv = cubeastCSV([solve], cube);
  expect(csv).toContain('"Practice, ""fast""\r\ncubes"');
  expect(csv).toContain('"Cube, ""test"""');
  expect(csv).toContain('"Line 1\nLine 2"');
  expect(solve).toEqual(before);
});

test('Cubeast CSV excludes active attempts, includes incomplete attempts as DNFs, and preserves all sessions', () => {
  const complete = sample(), incomplete = { ...sample(), session: 'Other', status: 'incomplete' as const, reason: 'Disconnected.' };
  const [header, first, second, trailing] = cubeastCSV([complete, incomplete, { ...sample(), status: 'active' }], cube).split('\r\n');
  expect(trailing).toBe('');
  expect(first.split(',')[0]).toBe(complete.id);
  const columns = header.split(','), cells = second.split(',');
  const row = Object.fromEntries(columns.map((column, i) => [column, cells[i]]));
  expect(cells).toHaveLength(164);
  expect(row).toMatchObject({ dnf: 'true', time: '', timer_time: '', solving_time: '', session_name: 'Other', description: 'Disconnected.' });
  expect(row.solution).toBe("U2[0] R'[100]");
  expect(cubeastCSV([], cube)).toBe(cubeastHeader + '\r\n');
});
