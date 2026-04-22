import { useEffect, useState } from "react"

type DisplayMode = "off" | "scorebug" | "playerstats"

export default function GameSelectorPopup() {
  // --- State Management ---
  const [games, setGames] = useState<any[]>([]) // Holds the list of today's NBA games
  const [selectedGame, setSelectedGame] = useState<string>("") // ID of the currently tracked game
  const [loading, setLoading] = useState(true) // UI loading state for the schedule fetch
  const [errorMsg, setErrorMsg] = useState<string>("") // Error handling for failed fetches
  const [latencySeconds, setLatencySeconds] = useState<number>(0) // User-defined sync delay
  const [latencySaved, setLatencySaved] = useState(false) // Visual feedback state for the save button
  const [displayMode, setDisplayMode] = useState<DisplayMode>("scorebug") // Current UI mode on the webpage

  // --- Initialization ---
  useEffect(() => {
    // 1. Fetch today's scoreboard from the NBA static CDN
    const fetchSchedule = async () => {
      try {
        const response = await fetch("https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json")
        const data = await response.json()
        setGames(data.scoreboard?.games || [])
        setLoading(false)
      } catch (e) {
        setErrorMsg("Failed to reach NBA servers.")
        setLoading(false)
      }
    }

    fetchSchedule()

    // 2. Load saved user preferences from Chrome local storage
    try {
      if (chrome?.storage?.local) {
        chrome.storage.local.get(["selectedGameId", "delaySeconds", "displayMode"], (result) => {
          if (result.selectedGameId) setSelectedGame(result.selectedGameId)
          if (result.delaySeconds) setLatencySeconds(result.delaySeconds)
          if (result.displayMode) setDisplayMode(result.displayMode)
        })
      }
    } catch (err) {
      console.warn("Storage API not available", err)
    }
  }, [])

  // --- Event Handlers ---

  // Triggered when the user clicks a game from the list
  const handleSelectGame = (gameId: string) => {
    setSelectedGame(gameId)
    if (chrome?.storage?.local) chrome.storage.local.set({ selectedGameId: gameId })
    // Notify the background script to start fetching data for the new game
    if (chrome?.runtime?.sendMessage) chrome.runtime.sendMessage({ type: "CHANGE_GAME", gameId }).catch(() => {})
  }

  // Triggered when the user clicks "SET" on the TV delay panel
  const handleSetLatency = () => {
    if (chrome?.runtime?.sendMessage) {
      // Notify the background script to update its buffer calculation
      chrome.runtime.sendMessage({ type: "SET_LATENCY", seconds: latencySeconds }).catch(() => {})
      // Show a temporary "SAVED ✓" confirmation for 2 seconds
      setLatencySaved(true)
      setTimeout(() => setLatencySaved(false), 2000)
    }
  }

  // Triggered when the user clicks Off, Scorebug, or Player Stats
  const handleSetDisplayMode = (mode: DisplayMode) => {
    setDisplayMode(mode)
    if (chrome?.storage?.local) chrome.storage.local.set({ displayMode: mode })
    // Notify the background script/content scripts to change the UI immediately
    if (chrome?.runtime?.sendMessage) chrome.runtime.sendMessage({ type: "SET_DISPLAY_MODE", mode }).catch(() => {})
  }

  const modeButtons: { label: string, value: DisplayMode }[] = [
    { label: "Off", value: "off" },
    { label: "Scorebug", value: "scorebug" },
    { label: "Player Stats", value: "playerstats" }
  ]

  return (
    <div style={{ width: "320px", minHeight: "200px", backgroundColor: "#0f0f14", color: "white", fontFamily: "sans-serif", padding: "15px" }}>

      {/* DISPLAY MODE TOGGLE: Allows user to switch overlay layouts or turn it off */}
      <div style={{ backgroundColor: "#1a1a24", padding: "12px", borderRadius: "8px", marginBottom: "16px", border: "1px solid #333" }}>
        <h3 style={{ margin: "0 0 10px 0", fontSize: "14px", color: "#00ff00" }}>Display Mode</h3>
        <div style={{ display: "flex", gap: "6px" }}>
          {modeButtons.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => handleSetDisplayMode(value)}
              style={{
                flex: 1, padding: "8px 4px", fontSize: "12px", fontWeight: "bold",
                backgroundColor: displayMode === value ? "#00ff00" : "#0f0f14",
                color: displayMode === value ? "black" : "#888",
                border: displayMode === value ? "2px solid #00ff00" : "2px solid #333",
                borderRadius: "6px", cursor: "pointer", transition: "all 0.2s"
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* LATENCY PANEL: Allows user to artificially delay the API data to sync with their broadcast */}
      <div style={{ backgroundColor: "#1a1a24", padding: "12px", borderRadius: "8px", marginBottom: "16px", border: "1px solid #333" }}>
        <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", color: "#00ff00" }}>⏱ TV Delay</h3>
        <p style={{ fontSize: "11px", color: "#888", margin: "0 0 10px 0" }}>
          How many seconds behind is your TV? Set to 0 for live.
        </p>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <input
            type="number"
            min={0}
            max={120}
            value={latencySeconds}
            onChange={(e) => setLatencySeconds(Number(e.target.value))}
            style={{
              width: "70px", padding: "6px", backgroundColor: "#0f0f14",
              color: "white", border: "1px solid #444", borderRadius: "4px",
              textAlign: "center", fontSize: "16px"
            }}
          />
          <span style={{ color: "#888", fontSize: "13px" }}>seconds</span>
          <button
            onClick={handleSetLatency}
            style={{
              flex: 1, padding: "6px", backgroundColor: latencySaved ? "#005500" : "#00ff00",
              color: latencySaved ? "#00ff00" : "black", border: "none",
              borderRadius: "4px", fontWeight: "bold", cursor: "pointer", transition: "all 0.3s"
            }}
          >
            {latencySaved ? "SAVED ✓" : "SET"}
          </button>
        </div>
      </div>

      {/* GAME LIST: Renders the schedule fetched from the NBA CDN */}
      <h2 style={{ margin: "0 0 15px 0", fontSize: "18px", color: "white", borderBottom: "1px solid #333", paddingBottom: "10px" }}>
        Live Games
      </h2>

      {/* Conditional rendering based on fetch state (Loading -> Error -> Empty -> List) */}
      {loading ? (
        <div style={{ textAlign: "center", color: "#888", marginTop: "20px" }}>Loading today's games...</div>
      ) : errorMsg ? (
        <div style={{ textAlign: "center", color: "#ff4757", marginTop: "20px" }}>{errorMsg}</div>
      ) : games.length === 0 ? (
        <div style={{ textAlign: "center", color: "#888", marginTop: "20px" }}>No games scheduled today.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxHeight: "300px", overflowY: "auto" }}>
          {games.map((game) => {
            const isSelected = selectedGame === game.gameId
            return (
              <button
                key={game.gameId}
                onClick={() => handleSelectGame(game.gameId)}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "12px", backgroundColor: isSelected ? "rgba(0, 255, 0, 0.1)" : "#1a1a24",
                  border: isSelected ? "2px solid #00ff00" : "2px solid transparent",
                  borderRadius: "8px", color: "white", cursor: "pointer", transition: "all 0.2s"
                }}
              >
                {/* Team Matchup */}
                <div style={{ display: "flex", gap: "15px", alignItems: "center" }}>
                  <span style={{ fontWeight: "bold", fontSize: "16px" }}>{game.awayTeam.teamTricode}</span>
                  <span style={{ color: "#666", fontSize: "12px" }}>@</span>
                  <span style={{ fontWeight: "bold", fontSize: "16px" }}>{game.homeTeam.teamTricode}</span>
                </div>
                {/* Game Status (Pre-game, Live, or Final) */}
                <div style={{ fontSize: "12px", color: isSelected ? "#00ff00" : "#888", fontWeight: "bold" }}>
                  {game.gameStatus === 1 ? "PRE" : game.gameStatus === 2 ? "LIVE" : "FINAL"}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}