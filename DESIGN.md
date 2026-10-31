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
   a solved ordinary 3x3. Preserve the result until the user starts the next scramble.
7. Save locally, show statistics, and support timeline replay and JSON backup.

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
large timer and status, live cube with guidance, and recent solve history.
Replay includes play/pause, speed selection, and move stepping. A clearly labeled
simulated cube uses the same engine and persistence path for development/testing.

IndexedDB stores versioned solve records: identifier, session name, creation date,
device, scramble, starting state, duration, integrity, timing basis, raw moves,
and optional orientation samples. Persist active attempts incrementally so reloads
can retain interrupted recordings. Surface storage failures; never claim a solve
was saved if its transaction failed. Export/import validates the complete schema
and preserves data without a backend. Imports merge by identifier.

Statistics include completed single times, best, move count, TPS, Ao5, and Ao12.
Incomplete attempts remain visible but are excluded from completed-solve averages.
CFOP/Roux recognition/execution analysis, third-party CSV compatibility, accounts,
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
