# Timer design

## Non-negotiable architecture

**There is no API or backend. Everything runs within the browser.**
The production deployment consists only of static HTML, JavaScript, CSS, and
bundled assets/workers. Bluetooth, scrambling, solving, timing, replay, statistics,
and data import/export execute locally. Solves remain in IndexedDB on the user's
device. No accounts, server database, analytics, telemetry upload, remote solver,
or cloud synchronization are introduced. Dependencies are bundled at build time,
not fetched from a CDN at runtime.

## Scope and technology

Build a 3x3 smart-cube timer inspired by Cubeast and Acubemy, using React,
TypeScript, Vite, and Bootstrap, consistent with smartcubeanalyzer. Use
`smartcube-web-bluetooth` for multi-vendor connectivity and `cubing.js` for
random-state scrambles, puzzle calculations, and visualization. Pin the Bluetooth
GitHub dependency to a commit and commit the npm lockfile when a release is approved.

The Bluetooth library documents GAN, Giiker/Mi, GoCube/Rubik's Connected, MoYu,
QiYi, and XMD support; actual support remains model/firmware dependent. Initial
hardware validation targets Chrome/Edge on Windows. HTTPS (or localhost for
development) and a user-triggered device chooser are required. Detect missing
browser capabilities and explain limitations without pretending to connect.

This empty repository necessarily establishes an initial production-code baseline;
subsequent changes should keep code flat or shrinking. Tests do not count toward
production line budgets. Never commit, push, bump a release, or deploy without
explicit permission.

## User workflow

1. Connect a cube and synchronize its physical state. Never silently reset it.
   Read current facelets where supported. If unavailable, the user must physically
   solve the cube and explicitly confirm calibration.
2. Generate a random-state 3x3 scramble and display it at the top of the page.
   Use a fixed cube face frame and explain that U/F labels follow calibration,
   not the viewer's current grip. Gyroscope rotations are not face turns.
3. Guide the scramble with a live cube, completed/current/remaining instructions,
   and the next required turn. Compare cube states rather than raw notation:
   two quarter turns can satisfy one double turn.
4. For a mistake, guide inverse moves back to the last confirmed checkpoint.
   From an arbitrary synchronized state, provide a local solver-generated setup
   back to solved before the displayed scramble. Recompute guidance after resync.
5. Arm only when the cube matches the full scramble. Inspection is unlimited.
   The last scramble turn does not start the timer. The next face turn starts it
   and is recorded as the first solve move.
6. Process every received move in order. The turn that solves the cube stops the
   timer and remains in the recording. Ignore center orientation when recognizing
   a solved ordinary 3x3. Automatically prepare the next scramble, retaining the
   last time until the next solve starts. Buffer incoming moves and snapshots
   during preparation without changing their original host timestamps.
7. Save locally, show statistics, and support timeline replay, Cubeast CSV export,
   and lossless JSON backup.

## State and integrity

States: disconnected, synchronizing, scrambling, ready, solving, finished,
and recovery. A framework-independent engine owns puzzle state, instructions,
timing, recording, and state transitions. React renders snapshots; animation
must not determine timing or event order.

Keep raw reported face turns, host monotonic timestamps, optional device
timestamps/counters, and optional orientation samples. Preserve repetitions.
Derive replay notation, turn count, and TPS separately. Live timing uses
`performance.now()`. Where sufficiently trustworthy paired timestamps exist,
fit device time to the host clock for finalized timing, retaining both clocks.
Otherwise label the host timing basis explicitly.

Use device counters for duplicate detection when available; do not deduplicate
identical notation or equal timestamps, which can describe legitimate repeated
turns. Check device facelet snapshots against move-derived state. Recover
notification history where the driver supports it. On an unrecoverable gap,
state mismatch, disconnect, or reload during a solve, preserve an incomplete
attempt rather than claim a complete reconstruction. A snapshot cannot recreate
unknown intervening moves. Resynchronization never silently resumes that attempt.

"Every move" means every recoverable device-reported face turn. Unsupported
rotations and moves irretrievably lost by hardware cannot be invented.
Only validated legal 54-facelet 3x3 states can be accepted. 2x2 is out of scope.

## Screen and local data

Responsive layout: connection and battery controls, scramble across the top,
large timer, status, and cube together in one card, and recent solve history.
Replay includes play/pause, speed selection, and move stepping. A clearly labeled
simulated cube uses the same engine and persistence path for development/testing.

IndexedDB stores versioned solve records: identifier, session name, creation date,
device, scramble, starting state, duration, integrity, timing basis, raw moves,
and optional orientation samples. Persist active attempts incrementally so reloads
can retain interrupted recordings. Surface storage failures; never claim a solve
was saved if its transaction failed. Export/import validates the complete schema
and preserves data without a backend. Imports merge by identifier.

Statistics include current/best Single, Ao5, Ao12, Ao100, and Ao1000, plus move
count and TPS. Best averages examine every rolling completed-solve window in the
session, not just displayed rows. Ao5/Ao12 trim one fastest and slowest result;
Ao100 trims five each, and Ao1000 fifty each. The latest incomplete single is
shown as DNF, and unavailable statistics as `--`. Cache statistics between timer
ticks to avoid repeatedly scanning session history.
Incomplete attempts remain visible but are excluded from completed-solve averages.
CSV exports match the 164-column Cubeast sample schema in smartcubeanalyzer.
Export finished attempts across all sessions, excluding active recordings.
Use UTC dates, millisecond times, and raw `move[timestamp]` solution notation;
incomplete attempts are DNFs with blank result times. Quote special CSV characters.
CFOP analysis runs incrementally from every recorded turn during the solve, not
only on export. Show Cross, F2L Pair 1/2/3/4, OLL, and PLL milestones beside the
timer with cumulative completion times. Lock the first correctly aligned cross
on any face; simultaneous initial crosses use a deterministic D-first tie-break.
Subsequent F2L milestones require that cross intact and 1/2/3/4 pairs simultaneously
solved. Milestones remain latched. OLL requires complete F2L and orientation of the
opposite face; PLL includes final AUF and requires fully solved state. Initially
complete and same-turn stages use shared boundaries and zero-move skips.
Incomplete or subsequently invalidated attempts cannot claim PLL completion.
Derive the same analysis from old recordings without changing the backup schema.
CSV contains seven CFOP stages and their moves, normalized into a D-cross frame,
with fitted-device or host times matching the full timeline. Recognition is
inferred from the gap to a stage's first turn (zero for Cross); execution is the
remaining stage time, not a measurement of the user's thinking. Unknown physical
color, case IDs, and unavailable metadata stay blank. JSON backups additionally
preserve raw device clocks and orientation samples.
Display a live trail across the timer/cube card, auto-rescaling to fit the solve
and filling the full width with proportional durations at completion. Use
smartcubeanalyzer's dark Cross/OLL/PLL colors and related purple shades for F2L.
Recognition uses a darker shade of its step color; execution uses the lighter
shade. Show duration callouts along the bar, anchored to each step's midpoint;
spread crowded labels and use multiple rows on narrow screens. Omit the separate
base-cross label, step badges, and explanatory paragraph. Tooltips retain step
names and the recognition/execution breakdown. Derive bar and CSV timings with the same
helper. Zero-time skips consume no width, and incomplete stages remain pending.
Time precision is a browser-persisted option (hundredths or thousandths), applied
consistently to timer, steps, history, statistics, and replay without altering raw
recordings or exports.

Roux analysis, Acubemy CSV compatibility, accounts,
multiplayer, 2x2, and formal WCA inspection penalties are outside the first release.

## Implementation sequence and acceptance

1. Static app/tooling, local puzzle operations, and deterministic engine.
2. Bluetooth adapter, calibration, guidance, and automatic timing.
3. IndexedDB history, interrupted attempts, statistics, JSON backup, and replay.
4. Focused engine/storage/UI tests, typecheck, lint, and production build.
5. Real-cube validation: pairing, initial facelets, orientation convention,
   wrong-turn recovery, first/final-turn boundaries, packet recovery, and replay.

Automated cases must include double turns, mistakes/undo, solved-state detection,
duplicate events, counter gaps, reordered/stale snapshots, failed storage,
invalid imports, disconnect/reload, and the full simulated scramble/solve workflow.
Simulated tests do not substitute for physical hardware acceptance.

## Production bundling

The solver's module worker shares a dedicated `cubing-core` chunk with the main
page. Keep that chunk free of React and browser UI initialization. Vite module
preloading is disabled because its document-based helper cannot run in workers.
The production browser test must exercise scramble generation, not just the
development server, and reject external HTTP requests.

## References

- https://github.com/poliva/smartcube-web-bluetooth
- https://github.com/afedotov/gan-web-bluetooth
- https://js.cubing.net/cubing/
- https://developer.chrome.com/docs/capabilities/bluetooth
