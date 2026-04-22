let CURRENT_GAME_ID = ""
let latencyDelayMs = 0
// Buffer to store historical API responses so we can artificially delay the broadcast
let dataBuffer: { timestamp: number, payload: any }[] = []

// Attempt to load saved preferences (game ID and sync delay) when the extension boots up
try {
  chrome.storage.local.get(["selectedGameId", "delaySeconds"], (result) => {
    if (result.selectedGameId) CURRENT_GAME_ID = result.selectedGameId
    if (result.delaySeconds) latencyDelayMs = result.delaySeconds * 1000
  })
} catch (e) {
  console.warn("Storage API not available on boot", e)
}

// Listen for messages coming from the popup or content scripts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "CHANGE_GAME") {
    CURRENT_GAME_ID = msg.gameId
    dataBuffer = [] // Clear old data when switching games
    fetchGameData()
  }

  if (msg.type === "SET_LATENCY") {
    latencyDelayMs = msg.seconds * 1000
    chrome.storage.local.set({ delaySeconds: msg.seconds })
  }

  if (msg.type === "SET_DISPLAY_MODE") {
    // Forward the mode change directly to all NBA tabs immediately (bypassing the delay buffer)
    chrome.tabs.query({ url: "https://www.nba.com/*" }, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) chrome.tabs.sendMessage(tab.id, { type: "SET_DISPLAY_MODE", mode: msg.mode }).catch(() => {})
      }
    })
  }
})

// Helper function to extract and format stats for the 5 players currently on the court
const getOnCourtPlayers = (team: any) => {
  return team.players
    .filter((p: any) => p.oncourt === "1")
    .slice(0, 5) // Ensure we only ever grab a max of 5 players
    .map((p: any) => ({
      id: p.personId,
      name: p.nameI,
      // Position abbreviation shown on the player card (PG, SG, SF, PF, C)
      position: p.position || "",
      pts: p.statistics.points,
      reb: p.statistics.reboundsTotal,
      ast: p.statistics.assists,
      fouls: p.statistics.foulsPersonal,
      min: p.statistics.minutesCalculated?.replace("PT", "").replace("M", "") ?? "0",
      fgm: p.statistics.fieldGoalsMade,
      fga: p.statistics.fieldGoalsAttempted,
      tpm: p.statistics.threePointersMade,
      tpa: p.statistics.threePointersAttempted,
      ftm: p.statistics.freeThrowsMade,
      fta: p.statistics.freeThrowsAttempted,
      oreb: p.statistics.reboundsOffensive,
      stl: p.statistics.steals,
      blk: p.statistics.blocks,
      tov: p.statistics.turnovers,
      plusMinus: p.statistics.plusMinusPoints
    }))
}

// Main function to pull live data from NBA's static CDN
const fetchGameData = async () => {
  if (!CURRENT_GAME_ID) return

  const boxUrl = `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${CURRENT_GAME_ID}.json`
  const pbpUrl = `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${CURRENT_GAME_ID}.json`

  try {
    // 1. Fetch Boxscore (Scores, Clock, Player Stats)
    const boxRes = await fetch(boxUrl)
    const boxData = await boxRes.json()
    const game = boxData.game

    // 2. Fetch Play-by-Play (Text descriptions of what just happened)
    let actions = []
    try {
      const pbpRes = await fetch(pbpUrl)
      if (pbpRes.ok && pbpRes.headers.get("content-type")?.includes("application/json")) {
        const pbpData = await pbpRes.json()
        actions = pbpData.game?.actions || []
      }
    } catch (e) {
      console.warn("PBP not available")
    }

    // Find the most recent play description by iterating backwards through the actions array
    let latestPlayText = game.gameStatus === 1 ? "Awaiting tip-off..." : "Waiting for play data..."
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].description) {
        latestPlayText = actions[i].description
        break
      }
    }

    // Construct the standardized payload for the front-end overlay
    const payload = {
      type: "UPDATE_BOXSCORE",
      clock: game.gameClock,
      period: game.period,
      gameStatus: game.gameStatus,
      latestPlay: latestPlayText,
      awayTeam: {
        score: game.awayTeam.score,
        tricode: game.awayTeam.teamTricode,
        timeouts: game.awayTeam.timeoutsRemaining,
        fouls: game.awayTeam.statistics.foulsTeam,
        inBonus: game.awayTeam.inBonus == 1,
        onCourt: getOnCourtPlayers(game.awayTeam)
      },
      homeTeam: {
        score: game.homeTeam.score,
        tricode: game.homeTeam.teamTricode,
        timeouts: game.homeTeam.timeoutsRemaining,
        fouls: game.homeTeam.statistics.foulsTeam,
        inBonus: game.homeTeam.inBonus == 1,
        onCourt: getOnCourtPlayers(game.homeTeam)
      }
    }

    // Store the payload in the buffer with a timestamp instead of sending it immediately
    dataBuffer.push({ timestamp: Date.now(), payload })
    // Keep memory clean by limiting the buffer to the last 120 payloads (~10 mins at 5s intervals)
    if (dataBuffer.length > 120) dataBuffer.shift()

  } catch (e) {
    console.error("Boxscore fetch failed", e)
  }
}

// Broadcaster Interval: Runs every second to send data to the active web pages
setInterval(() => {
  if (dataBuffer.length === 0) return

  // Calculate what time we *should* be displaying based on the user's sync delay setting
  const targetTime = Date.now() - latencyDelayMs
  let closestPayload = dataBuffer[0].payload
  let smallestDiff = Infinity

  // Find the payload in the buffer that closest matches our target delayed time
  for (const item of dataBuffer) {
    const diff = Math.abs(item.timestamp - targetTime)
    if (diff < smallestDiff) {
      smallestDiff = diff
      closestPayload = item.payload
    }
  }

  // Send the delayed payload to any open NBA.com tabs
  chrome.tabs.query({ url: "https://www.nba.com/*" }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, closestPayload).catch(() => {})
    }
  })
}, 1000)

// Start the fetching loop: fetch immediately on boot, then every 5 seconds
fetchGameData()
setInterval(fetchGameData, 5000)