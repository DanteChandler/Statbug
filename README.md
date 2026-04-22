# 🏀 Statbug: Real-Time NBA Overlay

**Never take your eyes off the game.** Statbug is a Chrome extension that injects a broadcast-quality, real-time scorebug and live player stats directly into NBA.com. 

Whether you're tracking your fantasy team or just want deeper insights without opening a second tab, Statbug brings the box score to your screen without interrupting the action. Built with [Plasmo](https://docs.plasmo.com/) and React.

## ✨ Key Features

* **📊 Two Display Modes:** * **Scorebug:** A sleek, bottom-screen broadcast bar featuring live scores, game clock, timeouts, bonus status, and play-by-play updates.
  * **Player Stats:** A top-screen, interactive roster bar displaying the 5 players currently on the court for each team. Click any player to expand their full, real-time box score.
* **⏱️ TV Delay Sync:** Live API data is often faster than your stream. Set your custom delay in seconds to perfectly sync the overlay with your screen and avoid spoilers!
* **⚡ Live Animations:** Visual cues highlight players the moment they score or pick up critical fouls.
* **🎯 Zero Clutter:** Only runs on `nba.com`. Easily toggle the overlay on, off, or switch modes on the fly via the extension popup.

---

## 🛠️ Developer Setup

If you want to download the code, tweak it, or run it locally, follow these steps:

### 1. Install Dependencies
Make sure you have [Node.js](https://nodejs.org/) installed, then run:
```bash
npm install
# or
pnpm install