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
    dataBuffer = []
    fetchGameData()
  }
  if (msg.type === "SET_LATENCY") {
    latencyDelayMs = msg.seconds * 1000
    chrome.storage.local.set({ delaySeconds: msg.seconds })
  }
  if (msg.type === "SET_DISPLAY_MODE") {
    chrome.tabs.query({ url: "<all_urls>" }, (tabs) => {
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
    .slice(0, 5)
    .map((p: any) => ({
      id: p.personId,
      name: p.nameI,
      // Jersey number shown as a small badge next to the name
      number: p.jerseyNum || "",
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

// Helper to build team-level stats for the team stats drawer
const getTeamStats = (team: any) => ({
  fgm: team.statistics.fieldGoalsMade,
  fga: team.statistics.fieldGoalsAttempted,
  fgPct: team.statistics.fieldGoalsPercentage
    ? `${(team.statistics.fieldGoalsPercentage * 100).toFixed(1)}%` : "-",
  tpm: team.statistics.threePointersMade,
  tpa: team.statistics.threePointersAttempted,
  tpPct: team.statistics.threePointersPercentage
    ? `${(team.statistics.threePointersPercentage * 100).toFixed(1)}%` : "-",
  ftm: team.statistics.freeThrowsMade,
  fta: team.statistics.freeThrowsAttempted,
  ftPct: team.statistics.freeThrowsPercentage
    ? `${(team.statistics.freeThrowsPercentage * 100).toFixed(1)}%` : "-",
  reb: team.statistics.reboundsTotal,
  oreb: team.statistics.reboundsOffensive,
  dreb: team.statistics.reboundsDefensive,
  ast: team.statistics.assists,
  tov: team.statistics.turnovers,
  stl: team.statistics.steals,
  blk: team.statistics.blocks,
  pitp: team.statistics.pointsInThePaint,
  fastBreak: team.statistics.pointsFastBreak,
  secondChance: team.statistics.pointsSecondChance,
  benchPts: team.statistics.benchPoints,
  foulsTeam: team.statistics.foulsTeam,
})

// Main function to pull live data from NBA's static CDN
const fetchGameData = async () => {
  if (!CURRENT_GAME_ID) return

  const boxUrl = `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${CURRENT_GAME_ID}.json`
  const pbpUrl = `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${CURRENT_GAME_ID}.json`

  try {
    const boxRes = await fetch(boxUrl)
    const boxData = await boxRes.json()
    const game = boxData.game

    let actions: any[] = []
    try {
      const pbpRes = await fetch(pbpUrl)
      if (pbpRes.ok && pbpRes.headers.get("content-type")?.includes("application/json")) {
        const pbpData = await pbpRes.json()
        actions = pbpData.game?.actions || []
      }
    } catch (e) {
      console.warn("PBP not available")
    }

    // Grab the last 5 plays with descriptions for the play-by-play ticker
    const recentPlays: { text: string, clock: string, period: number }[] = []
    for (let i = actions.length - 1; i >= 0 && recentPlays.length < 5; i--) {
      const a = actions[i]
      if (a.description) {
        recentPlays.push({
          text: a.description,
          // Game clock at the time the play happened
          clock: a.clock || "",
          period: a.period || 0
        })
      }
    }

    const latestPlay = recentPlays[0] || { text: game.gameStatus === 1 ? "Awaiting tip-off..." : "Waiting for play data...", clock: "", period: 0 }

    const payload = {
      type: "UPDATE_BOXSCORE",
      clock: game.gameClock,
      period: game.period,
      gameStatus: game.gameStatus,
      // Most recent play for the ticker
      latestPlay: latestPlay.text,
      latestPlayClock: latestPlay.clock,
      latestPlayPeriod: latestPlay.period,
      awayTeam: {
        score: game.awayTeam.score,
        tricode: game.awayTeam.teamTricode,
        name: game.awayTeam.teamName,
        timeouts: game.awayTeam.timeoutsRemaining,
        fouls: game.awayTeam.statistics.foulsTeam,
        inBonus: game.awayTeam.inBonus == 1,
        onCourt: getOnCourtPlayers(game.awayTeam),
        // Full team stats for the slide-down drawer
        teamStats: getTeamStats(game.awayTeam)
      },
      homeTeam: {
        score: game.homeTeam.score,
        tricode: game.homeTeam.teamTricode,
        name: game.homeTeam.teamName,
        timeouts: game.homeTeam.timeoutsRemaining,
        fouls: game.homeTeam.statistics.foulsTeam,
        inBonus: game.homeTeam.inBonus == 1,
        onCourt: getOnCourtPlayers(game.homeTeam),
        teamStats: getTeamStats(game.homeTeam)
      }
    }

    dataBuffer.push({ timestamp: Date.now(), payload })
    if (dataBuffer.length > 120) dataBuffer.shift()

  } catch (e) {
    console.error("Boxscore fetch failed", e)
  }
}

// Broadcaster: runs every second, applies the user's latency delay
setInterval(() => {
  if (dataBuffer.length === 0) return
  const targetTime = Date.now() - latencyDelayMs
  let closestPayload = dataBuffer[0].payload
  let smallestDiff = Infinity
  for (const item of dataBuffer) {
    const diff = Math.abs(item.timestamp - targetTime)
    if (diff < smallestDiff) { smallestDiff = diff; closestPayload = item.payload }
  }
  chrome.tabs.query({ url: "*://*.nba.com/*" }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, closestPayload).catch(() => {})
    }
  })
}, 1000)

fetchGameData()
setInterval(fetchGameData, 5000)