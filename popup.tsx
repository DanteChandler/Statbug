import { useEffect, useState } from "react"

// The three display modes available to the user
type DisplayMode = "off" | "scorebug" | "statbug"

export default function GameSelectorPopup() {
  // --- State Management ---
  const [games, setGames] = useState<any[]>([])
  const [selectedGame, setSelectedGame] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string>("")
  const [latencySeconds, setLatencySeconds] = useState<number>(0)
  const [latencySaved, setLatencySaved] = useState(false)
  const [displayMode, setDisplayMode] = useState<DisplayMode>("scorebug")

  useEffect(() => {
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

  const handleSelectGame = (gameId: string) => {
    setSelectedGame(gameId)
    if (chrome?.storage?.local) chrome.storage.local.set({ selectedGameId: gameId })
    if (chrome?.runtime?.sendMessage) chrome.runtime.sendMessage({ type: "CHANGE_GAME", gameId }).catch(() => {})
  }

  const handleSetLatency = () => {
    if (chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "SET_LATENCY", seconds: latencySeconds }).catch(() => {})
      setLatencySaved(true)
      setTimeout(() => setLatencySaved(false), 2000)
    }
  }

  const handleSetDisplayMode = (mode: DisplayMode) => {
    setDisplayMode(mode)
    if (chrome?.storage?.local) chrome.storage.local.set({ displayMode: mode })
    if (chrome?.runtime?.sendMessage) chrome.runtime.sendMessage({ type: "SET_DISPLAY_MODE", mode }).catch(() => {})
  }

  const modeButtons: { label: string, value: DisplayMode }[] = [
    { label: "Off", value: "off" },
    { label: "Scorebug", value: "scorebug" },
    // Renamed from "Player Stats" to "Statbug"
    { label: "Statbug", value: "statbug" }
  ]

  return (
    <div style={{ width: "320px", minHeight: "200px", backgroundColor: "#0f0f14", color: "white", fontFamily: "sans-serif", padding: "15px" }}>

      {/* DISPLAY MODE TOGGLE */}
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

      {/* LATENCY PANEL */}
      <div style={{ backgroundColor: "#1a1a24", padding: "12px", borderRadius: "8px", marginBottom: "16px", border: "1px solid #333" }}>
        <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", color: "#00ff00" }}>⏱ TV Delay</h3>
        <p style={{ fontSize: "11px", color: "#888", margin: "0 0 10px 0" }}>
          How many seconds behind is your TV? Set to 0 for live.
        </p>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <input
            type="number" min={0} max={120} value={latencySeconds}
            onChange={(e) => setLatencySeconds(Number(e.target.value))}
            style={{ width: "70px", padding: "6px", backgroundColor: "#0f0f14", color: "white", border: "1px solid #444", borderRadius: "4px", textAlign: "center", fontSize: "16px" }}
          />
          <span style={{ color: "#888", fontSize: "13px" }}>seconds</span>
          <button
            onClick={handleSetLatency}
            style={{ flex: 1, padding: "6px", backgroundColor: latencySaved ? "#005500" : "#00ff00", color: latencySaved ? "#00ff00" : "black", border: "none", borderRadius: "4px", fontWeight: "bold", cursor: "pointer", transition: "all 0.3s" }}
          >
            {latencySaved ? "SAVED ✓" : "SET"}
          </button>
        </div>
      </div>

      {/* GAME LIST */}
      <h2 style={{ margin: "0 0 15px 0", fontSize: "18px", color: "white", borderBottom: "1px solid #333", paddingBottom: "10px" }}>
        Live Games
      </h2>
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
                <div style={{ display: "flex", gap: "15px", alignItems: "center" }}>
                  <span style={{ fontWeight: "bold", fontSize: "16px" }}>{game.awayTeam.teamTricode}</span>
                  <span style={{ color: "#666", fontSize: "12px" }}>@</span>
                  <span style={{ fontWeight: "bold", fontSize: "16px" }}>{game.homeTeam.teamTricode}</span>
                </div>
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