let CURRENT_GAME_ID = ""
let latencyDelayMs = 0
// Buffer to store historical API responses so we can artificially delay the broadcast
let dataBuffer: { timestamp: number; payload: any }[] = []

const NBA_CDN_BASE = "https://cdn.nba.com/static/json/liveData"
const NBA_S3_BASE =
  "https://nba-prod-us-east-1-mediaops-stats.s3.amazonaws.com/NBA/liveData"

const NBA_HEADERS = {
  Accept: "application/json"
}

// NBA's CDN can reject extension-origin requests with 403s.
// This MV3 rule makes NBA JSON calls look like they came from nba.com itself.
const setupNbaRequestHeaders = () => {
  const dnr = chrome.declarativeNetRequest
  if (!dnr?.updateDynamicRules) return

  dnr.updateDynamicRules(
    {
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders: [
              {
                header: "origin",
                operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE
              },
              {
                header: "referer",
                operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                value: "https://www.nba.com/"
              }
            ]
          },
          condition: {
            regexFilter:
              "^https://(cdn\\.nba\\.com/static/json|nba-prod-us-east-1-mediaops-stats\\.s3\\.amazonaws\\.com/NBA)/",
            resourceTypes: [
              chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST
            ]
          }
        }
      ]
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "Unable to configure NBA request headers:",
          chrome.runtime.lastError.message
        )
      }
    }
  )
}

setupNbaRequestHeaders()

// Try the CDN first, then the underlying mediaops bucket if the CDN refuses us.
const fetchJsonFromCandidates = async (urls: string[]) => {
  const errors: string[] = []

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        cache: "no-store",
        headers: NBA_HEADERS
      })

      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`.trim())
      }

      return res.json()
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  throw new Error(`NBA API returned no usable response. ${errors.join(" | ")}`)
}

const scoreboardUrls = () => [
  `${NBA_CDN_BASE}/scoreboard/todaysScoreboard_00.json`,
  `${NBA_S3_BASE}/scoreboard/todaysScoreboard_00.json`
]

const boxscoreUrls = (gameId: string) => [
  `${NBA_CDN_BASE}/boxscore/boxscore_${gameId}.json`,
  `${NBA_S3_BASE}/boxscore/boxscore_${gameId}.json`
]

const playByPlayUrls = (gameId: string) => [
  `${NBA_CDN_BASE}/playbyplay/playbyplay_${gameId}.json`,
  `${NBA_S3_BASE}/playbyplay/playbyplay_${gameId}.json`
]

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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
        if (tab.id)
          chrome.tabs
            .sendMessage(tab.id, { type: "SET_DISPLAY_MODE", mode: msg.mode })
            .catch(() => {})
      }
    })
  }

  // Keep schedule fetches in the background worker so host permissions apply.
  if (msg.type === "FETCH_SCHEDULE") {
    fetchJsonFromCandidates(scoreboardUrls())
      .then((data) => {
        sendResponse({ success: true, data: data })
      })
      .catch((err) => {
        console.error("Background Fetch Error:", err)
        sendResponse({ success: false, error: err.message })
      })

    return true // Required to keep the channel open for the async response
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
      min:
        p.statistics.minutesCalculated?.replace("PT", "").replace("M", "") ??
        "0",
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
    ? `${(team.statistics.fieldGoalsPercentage * 100).toFixed(1)}%`
    : "-",
  tpm: team.statistics.threePointersMade,
  tpa: team.statistics.threePointersAttempted,
  tpPct: team.statistics.threePointersPercentage
    ? `${(team.statistics.threePointersPercentage * 100).toFixed(1)}%`
    : "-",
  ftm: team.statistics.freeThrowsMade,
  fta: team.statistics.freeThrowsAttempted,
  ftPct: team.statistics.freeThrowsPercentage
    ? `${(team.statistics.freeThrowsPercentage * 100).toFixed(1)}%`
    : "-",
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
  foulsTeam: team.statistics.foulsTeam
})

// Main function to pull live data from NBA's static CDN
const fetchGameData = async () => {
  if (!CURRENT_GAME_ID) return

  try {
    const boxData = await fetchJsonFromCandidates(boxscoreUrls(CURRENT_GAME_ID))
    const game = boxData.game

    let actions: any[] = []
    try {
      const pbpData = await fetchJsonFromCandidates(
        playByPlayUrls(CURRENT_GAME_ID)
      )
      actions = pbpData.game?.actions || []
    } catch (e) {
      console.warn("PBP not available")
    }

    // Grab the last 5 plays with descriptions for the play-by-play ticker
    const recentPlays: { text: string; clock: string; period: number }[] = []
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

    const latestPlay = recentPlays[0] || {
      text:
        game.gameStatus === 1
          ? "Awaiting tip-off..."
          : "Waiting for play data...",
      clock: "",
      period: 0
    }

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
    if (diff < smallestDiff) {
      smallestDiff = diff
      closestPayload = item.payload
    }
  }
  chrome.tabs.query({ url: "*://*.nba.com/*" }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id)
        chrome.tabs.sendMessage(tab.id, closestPayload).catch(() => {})
    }
  })
}, 1000)

fetchGameData()
setInterval(fetchGameData, 5000)
