# 🎭 Fake Artist

A free browser party game. One player is secretly the **Fake** — they don't know the word, only the category. Everyone draws **one line per turn** on a shared canvas, then votes for the impostor.

- Works on **phone and PC**, no install, no signup.
- Everyone joins with a **4-letter room code**.
- Real-time via WebSockets.
- **Zero cost to run.** One tiny Node dependency (`ws`).

## How to play

1. One person taps **Create a room** and shares the 4-letter code.
2. Everyone else enters the code and joins.
3. Real players see the secret word. The Fake(s) see only the category.
4. Take turns adding **one line each** to the same drawing.
5. Vote for who you think is the Fake.
   - **Caught?** The Fake gets one shot at guessing the word.
   - Caught + wrong guess → every artist **+1**.
   - Caught + right guess → Fake **+2**.
   - Fake not caught → each Fake **+2**.

## Features

**Customize the room** (on the create screen, and live in the lobby by the host):
- **Custom words** — your own list (comma or newline separated). Overrides the built-in categories.
- **Custom hint** — the label the Fake sees when you use custom words.
- **Category** — Random or a built-in set (Animals, Food, Places, Objects, Nature, Jobs, Movies).
- **2 Fakes** — needs 4+ players; the lobby warns if you don't have enough.
- **Lines each** — 1 to 3 strokes per player per round.
- **Turn timer** — Off / 20s / 30s / 45s / 60s / 90s. Turns auto-pass when time runs out.
- **Fakes know each other** — optionally reveal the Fake teammates to each other.

**Party-friendly extras:**
- **Emoji reactions** — a floating reaction bar in every game screen; reactions pop up on everyone's screen with the sender's name and colour (rate-limited server-side).
- **Sound + animation** — ticking clock in the last seconds, drumroll before the reveal, win/lose jingles, your-turn chime, join/leave blips, haptics on mobile, and confetti. Volume slider + quick mute.
- **Installable app (PWA)** — "Add to Home Screen" on phone, works offline for the app shell, real icon.
- **Rematch keeps scores** — "Next round" starts fresh words but keeps the running total.
- **Running leaderboard** — visible in the lobby and at the reveal, with round-win stars and a host Reset.
- **Vote timer** — optional; missing votes are filled in automatically so a game can never stall.
- **Leave / kick / disband** — anyone can leave; the host can remove players (kicked players can't rejoin) or close the room for everyone.
- **Connection status** — a live dot shows when you drop, and you auto-rejoin the room when you're back.
- **Remembers your settings** — your last room configuration is restored next time.
- **Accessible + responsive** — honours "reduce motion", keyboard-friendly, and fits phone, tablet, desktop and landscape.

## Run it locally

Node and npm must be installed. If they aren't on your PATH, call them by full path.

```bash
npm install
npm start
```

Then open http://localhost:3000 on your PC. To test multiplayer on one machine, open the site in **separate browser tabs** (each tab is a separate player) or open it on your phone using your PC's LAN IP (e.g. `http://192.168.1.20:3000`).

### Windows / PowerShell note
Node and npm are already on your user PATH, but PowerShell blocks `npm.ps1` by default. If `npm` gives a "running scripts is disabled" error, use any of these:

```powershell
npm.cmd start                 # use the .cmd shim
# or allow scripts for this user once:
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
# or run from cmd.exe instead of PowerShell
```

## Deploy free (least work)

The server reads `process.env.PORT`, so it works on any Node host.

### Render (recommended — free tier, WebSocket support)
1. Push this folder to a GitHub repo.
2. Go to [render.com](https://render.com) → **New** → **Blueprint**.
3. Pick the repo. Render reads `render.yaml` and deploys automatically.
4. You get a public `https://...onrender.com` link. Share it.

> Note: Render's free tier sleeps after ~15 min idle and wakes on the next visit (takes a few seconds).

### Other free options
- **Railway / Fly.io / Koyeb** — same `npm start`; they inject `PORT`.
- **Docker** — `docker build -t fake-artist . && docker run -p 3000:3000 fake-artist`.
- **Your own PC + a tunnel** — run locally and share with `npx localtunnel --port 3000` or `cloudflared tunnel`.

## Files

```
server.js                 game + realtime server (rooms, turns, voting, scoring, timers, reactions, moderation)
public/index.html         screens, reaction bar, settings/rules modal
public/style.css          styling, animations, responsive layout
public/app.js             client logic, canvas drawing, sound system, PWA, settings
public/manifest.webmanifest  installable app manifest
public/sw.js              service worker (offline app shell)
public/icon-*.png         generated app icons
tools/make-icons.js       regenerates the icons
test/playtest.js          headless 3-player full-round test
test/features.js          timer / custom words / 2 fakes / rematch / kick / reactions / vote timer
render.yaml               free one-click deploy config
Dockerfile                deploy anywhere
```

## Tests

With the server running:

```bash
npm test
```

`playtest.js` drives a full round and checks the Fake never receives the word.
`features.js` checks the turn timer, custom words, two Fakes, scoring, rematch-keeps-scores, and kick/leave/disband.

## Tuning

- Words & categories: `CATEGORIES` in `server.js`.
- Player colors: `COLORS` in `server.js`.
- Player limits: `MIN_PLAYERS` / `MAX_PLAYERS` in `server.js`.
