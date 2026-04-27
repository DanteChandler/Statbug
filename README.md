# 🏀 Statbug: Real-Time NBA Overlay

**Never take your eyes off the game.** Statbug is a Chrome extension that injects a broadcast-quality, real-time scorebug and live player stats directly into NBA.com.

Whether you're tracking your fantasy team or just want deeper insights without opening a second tab, Statbug brings the box score to your screen without interrupting the action. Built with [Plasmo](https://docs.plasmo.com/) and React.

---

## ✨ Key Features

### 📺 Scorebug Mode
A sleek bottom-screen broadcast bar showing:
- Live scores with team colours and logos
- Smooth running game clock (interpolated between API updates)
- Quarter indicator and FINAL state
- Timeout dots and bonus/foul status per team
- Live play-by-play ticker at the bottom

### 📊 Statbug Mode
A fully interactive top-screen roster bar showing all 10 players currently on the court. For each player:
- Headshot, name, jersey number and position
- Live points, rebounds, assists and personal fouls
- Foul danger indicators (yellow at 4, red at 5)
- Click any player to expand their full box score: FG, 3PT, FT, OREB, STL, BLK, TO, +/-

The bottom strip shows:
- Away and home team tabs with foul count/bonus status and timeout dots
- Click either tab to slide down a full team stats drawer (FG%, 3P%, FT%, REB, AST, TOV, STL, BLK, PITP, fast break points, second chance points, bench points and more)
- Both team drawers can be open simultaneously, and close together when clicking outside
- Live play-by-play in the centre with the game clock timestamp for each play

### ⏱️ TV Delay Sync
Live API data is often ahead of your stream. Set a custom delay in seconds from the popup to perfectly sync the overlay with your broadcast and avoid spoilers.

### ⚡ Live Scoring Animations
When a player scores, their card lights up with a gold glow, their points pulse green, and their team's score animates

### 🎯 Zero Clutter
Only runs on `nba.com`. Toggle between Off, Scorebug, and Statbug instantly from the extension popup. Your last mode is saved between sessions.

---

## 🛠️ Developer Setup

### Prerequisites
- [Node.js](https://nodejs.org/) v18 or higher
- [npm](https://www.npmjs.com/) or [pnpm](https://pnpm.io/)
- Google Chrome

### 1. Clone the repo
```bash
git clone https://github.com/D4nte30/nba-scorebug.git
cd nba-scorebug
```

### 2. Install dependencies
```bash
npm install
# or
pnpm install
```

### 3. Run in development mode
```bash
npm run dev
```
This starts a live-reloading dev build. Plasmo outputs to `build/chrome-mv3-dev`.

### 4. Load the extension in Chrome
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `build/chrome-mv3-dev` folder

### 5. Build for production
```bash
npm run build
```
Output goes to `build/chrome-mv3-prod`.

---

## 📖 How to Use

1. Go to [nba.com](https://nba.com) during a live game
2. Click the Statbug icon in your Chrome toolbar
3. Select a game from the popup
4. Choose your display mode - **Scorebug** or **Statbug**
5. Set your TV delay if your stream is behind (optional)
6. Watch the overlay appear on the page automatically

---

## 🗂️ Project Structure

```
nba-scorebug/
├── content.tsx       # The overlay UI injected into NBA.com (React)
├── background.ts     # Service worker - fetches NBA API data and broadcasts it
├── popup.tsx         # Extension popup - game selector, mode toggle, delay setting
├── assets/           # Extension icons
└── package.json
```

---

## 📡 Data Sources

All data is pulled from NBA's official public CDN - no third-party APIs, no keys required:

| Endpoint | Used for |
|---|---|
| `cdn.nba.com/.../todaysScoreboard_00.json` | Today's game list |
| `cdn.nba.com/.../boxscore_{gameId}.json` | Live scores, player stats, clock |
| `cdn.nba.com/.../playbyplay_{gameId}.json` | Live play descriptions |

The background script polls every 5 seconds and broadcasts to all open NBA.com tabs, with a configurable delay buffer for TV sync.