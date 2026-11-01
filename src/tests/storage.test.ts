import 'fake-indexeddb/auto';
import { TimerEngine, type Solve } from '../engine';
import { Cube, loadCube, SOLVED } from '../puzzle';
import { average, backupJSON, cubeastCSV, readSolves, saveSolves, sessionStats, turns, validateBackup } from '../storage';

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
});

test('JSON backup preserves every raw timing and turn', () => {
  const solve = sample();
  expect(validateBackup(backupJSON([solve]), cube)).toEqual([solve]);
  expect(turns(solve)).toBe(3);
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

test('averages trim high/low and exclude incomplete attempts', () => {
  const solve = sample();
  const items = [1, 2, 3, 4, 100].map(n => ({ ...solve, duration: n * 1000 }));
  expect(average([{ ...solve, status: 'incomplete' }, ...items], 5)).toBe(3000);
  expect(average(items, 12)).toBeNull();
});

test('current and best singles respect the latest attempt while averages exclude unfinished recordings', () => {
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
  expect(row.inspection_time).toBe('');
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
