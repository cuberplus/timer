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
turn once to start the timer. It stops on the solving turn.

Some encrypted cubes need a Bluetooth MAC address. Enter it before connecting
if automatic discovery is unavailable. The cube must use the calibrated face
frame. If state reads are unavailable, physically solve it before confirming
calibration. Never confirm a scrambled cube as solved.

The Bluetooth dependency has a checked-in `patches/` fix, applied automatically
by `npm install`. Native GATT connection and service discovery each have a
15-second deadline, separate status messages, and no hidden retry loop.

History is stored in this browser's IndexedDB. Export JSON backups before
clearing site data. Interrupted attempts are retained and excluded from averages.
Simulated solves are labeled. Move counts and TPS use quarter-turn metric.

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
