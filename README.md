# Xiangqi 象棋

A two-player, pass-and-play Chinese Chess board for iPhone and iPad. It is a
dependency-free Progressive Web App: plain HTML, CSS and JavaScript, no build
step, no CDNs, and it runs 100% offline once installed.

- Full traditional rules: palace, river, elephant's eye, horse's leg, cannon
  screen, flying general, check, checkmate and stalemate (no legal move loses).
- **Local mode** (same table): undo, step-through move history, flip sides, and
  a face-to-face tabletop mode that turns the far player's pieces 180°.
- **Online mode** (different places): one player creates a game and shares a
  6-character challenge code (or an invite link); the other enters it. See
  [Online play](#online-play).
- Move timers; the game, clocks and settings are saved on every move and
  restored on launch (the local and the online game are kept separately).

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `styles.css` | App shell and wooden UI |
| `game.js` | Rules engine (also runs in Node for tests) |
| `ui.js` | Canvas renderer, input, timers, synthesised sound, persistence, mode switching |
| `net.js` | Challenge codes, AES-GCM encryption, tiny MQTT-over-WebSocket client |
| `online.js` | Online room protocol: seating, moves, takeback, resign, rematch, resume |
| `glyphs.js` | Calligraphy outlines for the pieces (generated, see below) |
| `sw.js`, `manifest.json`, `icons/` | Offline cache, install metadata, Home Screen icons |
| `vercel.json` | Cache and security headers; disables Vercel's automatic Git deployments |
| `scripts/`, `tests/` | Icon generator, dev server, deployment pruning, test suites |

## Run locally

```bash
npm start
```

Then open http://localhost:4173. (A server is needed because the app uses
root-relative paths and a service worker.)

```bash
npm test
```

runs the rules and PWA consistency tests with Node's built-in test runner.
`node scripts/verify-layout.js` is an optional Playwright smoke test of the
iPhone and iPad layouts and of offline reloads, and `node scripts/verify-online.js`
drives two simulated phones through a whole online game against the in-process
test broker in `tests/helpers/` (no internet needed).

## Online play

Menu → **Online** → **Create Game** shows a code such as `K7M-4PQ`. Send it to
your opponent by any means (**Share Invite** also builds a link that opens the
app and joins automatically). They choose **Join Game** and type the code.
Colours are assigned at random and swapped on each rematch; each player sees
their own colour at the bottom.

- Takeback requests, resignation and rematch are agreed through prompts.
- Closing the app, losing signal or switching to the local game does not end
  the game: it reconnects and catches up. The online game stays until someone
  chooses **Leave Online Game**.
- Online play needs a connection; local play and the app itself never do.

How it works, with no server of our own: both devices connect to a free public
MQTT broker (`net.js` lists them and tries each in turn) and exchange the full
game state as retained messages. The room topic and an AES-GCM key are both
derived from the challenge code on the device, so the broker only sees an
opaque topic and ciphertext, and nobody without the code can read or forge
moves. Every received history is also replayed through the rules engine.

Trade-offs of using public brokers: availability depends on third parties
(retained state can be dropped if a broker restarts), and the 6-character code
is the only secret, which is plenty for a casual game but not for anything
sensitive. To change brokers edit `BROKERS` in `net.js` **and** `connect-src`
in `vercel.json` (a test checks that the two agree).

## Deploy to Vercel

Deployment is production-only and driven by GitHub Actions
(`.github/workflows/deploy.yml`):

1. In Vercel, create a project for this repository (Framework preset **Other**,
   no build command, output directory left empty).
2. In GitHub, under **Settings → Secrets and variables → Actions**, add
   `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`.
3. Push to `main`. The workflow runs the tests, deploys with
   `vercel deploy --prod`, then deletes every deployment except the new live one.

No Preview deployments are created: the workflow only runs on `main`, and
`vercel.json` turns off Vercel's own Git integration builds.

When releasing a change, bump `CACHE_VERSION` in `sw.js` (and `APP_VERSION` in
`ui.js`, `version` in `package.json`) so installed copies start from a clean cache.

## Install on iPhone or iPad

1. Open the deployed `https://` address in **Safari**.
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Launch **Xiangqi** from the Home Screen. It opens full screen and works
   without a connection, including in Airplane Mode.

The same steps are in the app under **☰ → Install on iPhone / iPad**.

## Credits

The piece calligraphy in `glyphs.js` is derived from
[LXGW WenKai TC](https://github.com/lxgw/LxgwWenkaiTC) (SIL Open Font License
1.1, see `licenses/OFL.txt`). `scripts/extract-glyphs.py` regenerates it, and
`npm run icons` regenerates the PNG icons from it.
