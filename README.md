# Timer

A browser-only 3x3 smart-cube timer. **No API or backend exists.** Bluetooth,
scramble generation, state tracking, timing, replay, statistics, and IndexedDB
storage run on the user's device. Dependencies and solver workers are bundled.

## Develop

Install Node.js 22.12+ and Git, then run:

```powershell
npm install
npm start
```

Open `http://127.0.0.1:3000/timer/`. Use Chrome/Edge on Windows for Bluetooth,
or select **Try simulated cube**. Follow the highlighted scramble moves, then
turn once to start the timer. It stops on the solving turn and automatically
prepares the next scramble. The last time remains visible until the next solve.
Use **Options > Time precision** to choose hundredths (`0.00`, the default) or
thousandths (`0.000`) for timer, step, history, statistics, and replay times.
The browser remembers this display preference; recorded and exported timing is unchanged.

Some encrypted cubes need a Bluetooth MAC address. Enter it before connecting
if automatic discovery is unavailable. The cube must use the calibrated face
frame. If state reads are unavailable, physically solve it before confirming
calibration. Never confirm a scrambled cube as solved.

The Bluetooth dependency has a checked-in `patches/` fix, applied automatically
by `npm install`. Native GATT connection and service discovery each have a
15-second deadline, separate status messages, and no hidden retry loop.

History is stored in this browser's IndexedDB. Export JSON backups before
clearing site data. Interrupted attempts are retained as DNFs and included in averages.
The Current / records card shows current and best Single, Ao5, Ao12, Ao100, and
Ao1000, separately from session history and its replay/import/export controls.
Current averages use the latest finished attempts, including DNFs; best averages include every
rolling window in the selected session, even beyond the displayed history rows.
Ao5/Ao12 trim one fastest and slowest solve, Ao100 trims five each, and Ao1000
trims fifty each. DNFs rank as the worst times; any DNF remaining after trimming
makes the average DNF. The latest incomplete single displays DNF; insufficient averages
display `--`.
Simulated solves are labeled. Move counts and TPS use quarter-turn metric.
**Export Cubeast CSV** exports finished attempts across all sessions using the
exact 164-column smartcubeanalyzer sample schema. Move timestamps and result times
are milliseconds. **CFOP analysis runs live during each solve**, displaying Cross,
F2L Pair 1/2/3/4, OLL, and PLL completion times beside the timer. The first
correctly aligned cross on any face fixes the base for the remaining stages.
F2L milestones require that cross and 1/2/3/4 simultaneously solved pairs;
completed milestones stay marked even if later broken. OLL requires complete
F2L, and PLL includes final AUF. Initially complete or same-turn stages are skipped.
CSV exports include the same stages, timings, and moves normalized to a D-cross
frame. Recognition/execution splits are inferred from move gaps, not measured
thinking time; physical color and case metadata remain blank. CSV face/slice counts
and TPS use recorded face turns (a reported double turn counts once); quarter-turn
counts remain separate. Incomplete attempts are exported as DNFs. JSON backups
remain the lossless format for restoring all timing and orientation data.
The live colored trail auto-rescales to keep the whole solve visible, then shows
proportional step durations when finished. Cross/OLL/PLL colors follow
smartcubeanalyzer's dark palette; F2L pairs use related purple shades.
Recognition uses a darker shade of each step color, and execution a lighter shade.
Duration labels sit along the bar, with leaders pointing to their steps and
responsive spacing to keep short steps readable. The base-cross label, separate
step badges, and explanatory text are omitted. The bar and CSV share the same
inferred move-gap split; hover a segment or duration for the step name and timing
breakdown. Skips occupy no time; unfinished stages remain pending.

```powershell
npm test
npm run build
npm run preview
```

`npm run test:browser` exercises the production site in locally installed
Microsoft Edge, including network isolation, replay, reload recovery, and storage
failures. Run `npm run build` first.

Jest uses Node's experimental VM module support because cubing.js is ESM-only.
The build includes typecheck and ESLint; `any` and `unknown` are forbidden in
source declarations. Output is `build/`, with static-site base path `/timer/`.
Nothing is committed, pushed, or deployed automatically.

See [DESIGN.md](DESIGN.md) for architecture, integrity rules, and physical
hardware acceptance. Automated/simulated verification cannot certify a real cube.
