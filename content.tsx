import { useEffect, useState, useRef } from "react"
import type { PlasmoCSConfig, PlasmoGetRootContainer } from "plasmo"

// Inject this content script only on NBA.com pages
export const config: PlasmoCSConfig = {
  matches: ["*://*.nba.com/*"]
}

// Set up a custom root container for the React tree.
// Ensures the overlay stays visible even when the NBA video player goes fullscreen.
export const getRootContainer: PlasmoGetRootContainer = async () => {
  const root = document.createElement("div")
  root.id = "nba-scorebug-permanent-root"
  document.body.appendChild(root)
  const handleFullscreen = () => {
    const fsElement = document.fullscreenElement || (document as any).webkitFullscreenElement
    if (fsElement) fsElement.appendChild(root)
    else document.body.appendChild(root)
  }
  document.addEventListener("fullscreenchange", handleFullscreen)
  document.addEventListener("webkitfullscreenchange", handleFullscreen)
  return root
}

// Primary colour for each NBA team — used to tint player cards and gradients
const NBA_COLORS: Record<string, string> = {
  ATL: "#E03A3E", BOS: "#007A33", BKN: "#222222", CHA: "#1D1160",
  CHI: "#CE1141", CLE: "#860038", DAL: "#00538C", DEN: "#0E2240",
  DET: "#C8102E", GSW: "#1D428A", HOU: "#CE1141", IND: "#002D62",
  LAC: "#C8102E", LAL: "#552583", MEM: "#5D76A9", MIA: "#98002E",
  MIL: "#00471B", MIN: "#0C2340", NOP: "#0C2340", NYK: "#006BB6",
  OKC: "#007AC1", ORL: "#0077C0", PHI: "#006BB6", PHX: "#1D1160",
  POR: "#E03A3E", SAC: "#5A2D81", SAS: "#555555", TOR: "#CE1141",
  UTA: "#002B5C", WAS: "#002B5C"
}

// Display modes: off hides everything, scorebug is the bottom bar, statbug is the top bar
type DisplayMode = "off" | "scorebug" | "statbug"

// Formats an ISO clock string (e.g. "PT05M30.00S") into a readable "Q3 5:30" label
const formatPlayClock = (clock: string, period: number): string => {
  if (!clock || !period) return ""
  const match = clock.match(/PT(\d+)M(\d+\.?\d*)S/)
  if (!match) return ""
  const mins = parseInt(match[1])
  const secs = Math.floor(parseFloat(match[2]))
  const quarterLabel = period > 4 ? `OT${period - 4}` : `Q${period}`
  return `${quarterLabel} ${mins}:${secs.toString().padStart(2, "0")}`
}

export default function ScorebugOverlay() {
  // --- State Management ---
  const [data, setData] = useState<any>(null)
  const [displayMode, setDisplayMode] = useState<DisplayMode>("scorebug")
  const [displayClock, setDisplayClock] = useState<string>("")

  // Which player card is currently expanded to show detailed stats
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null)

  // Set allows both teams to be open simultaneously
  const [expandedTeamStats, setExpandedTeamStats] = useState<Set<string>>(new Set())

  // Scoring animation state — highlights the player and team that just scored
  const [scoringPlayerId, setScoringPlayerId] = useState<string | null>(null)
  const [scoringTricode, setScoringTricode] = useState<string | null>(null)

  // Refs for clock interpolation and previous data comparison
  const prevDataRef = useRef<any>(null)
  const clockAnchorRef = useRef<{
    seconds: number
    receivedAt: number
    running: boolean
    lastClockStr: string
  } | null>(null)

  // Ref on the statbug bar so clicks outside it close any open drawers
  const statBugRef = useRef<HTMLDivElement>(null)

  // --- Utility Functions ---

  // Converts "PT12M30.00S" into total seconds for clock interpolation
  const clockToSeconds = (clockStr: string): number => {
    if (!clockStr) return 0
    const match = clockStr.match(/PT(\d+)M(\d+\.?\d*)S/)
    if (!match) return 0
    return parseInt(match[1]) * 60 + parseFloat(match[2])
  }

  // Formats raw seconds into MM:SS or S.s when under a minute
  const secondsToDisplay = (secs: number): string => {
    if (secs <= 0) return "0:00"
    const m = Math.floor(secs / 60)
    const s = secs % 60
    if (m === 0) return s.toFixed(1)
    return `${m}:${Math.floor(s).toString().padStart(2, "0")}`
  }

  // Fallback clock formatter used before the ticker kicks in
  const formatClock = (clockStr: string): string => {
    if (!clockStr) return "00:00"
    const match = clockStr.match(/PT(\d+)M(\d+\.?\d*)S/)
    if (match) {
      const mins = parseInt(match[1], 10)
      const secs = parseFloat(match[2])
      if (mins === 0) return secs.toFixed(1)
      return `${mins.toString().padStart(2, "0")}:${Math.floor(secs).toString().padStart(2, "0")}`
    }
    return clockStr
  }

  // --- Effects ---
  useEffect(() => {
    // Restore the user's preferred display mode on mount
    try {
      chrome.storage.local.get(["displayMode"], (result) => {
        if (result.displayMode) setDisplayMode(result.displayMode)
      })
    } catch (e) {}

    // Close any open player/team drawers when clicking outside the statbug bar
    const handleClickOutside = (e: MouseEvent) => {
      if (statBugRef.current && !statBugRef.current.contains(e.target as Node)) {
        setExpandedPlayerId(null)
        // Clear the Set so both drawers close together
        setExpandedTeamStats(new Set())
      }
    }
    document.addEventListener("mousedown", handleClickOutside)

    // Handle incoming messages from the background script
    const handleMessage = (msg: any) => {
      if (msg.type === "SET_DISPLAY_MODE") {
        setDisplayMode(msg.mode)
        return
      }
      if (msg.type !== "UPDATE_BOXSCORE") return

      const prev = prevDataRef.current

      // Check if either team scored and trigger the scoring animation
      if (prev) {
        if (msg.awayTeam.score > prev.awayTeam.score) {
          setScoringTricode(msg.awayTeam.tricode)
          const scorer = msg.awayTeam.onCourt?.find((p: any) => {
            const pp = prev.awayTeam.onCourt?.find((x: any) => x.id === p.id)
            return pp && p.pts > pp.pts
          })
          setScoringPlayerId(scorer?.id ?? null)
          setTimeout(() => { setScoringPlayerId(null); setScoringTricode(null) }, 2000)
        } else if (msg.homeTeam.score > prev.homeTeam.score) {
          setScoringTricode(msg.homeTeam.tricode)
          const scorer = msg.homeTeam.onCourt?.find((p: any) => {
            const pp = prev.homeTeam.onCourt?.find((x: any) => x.id === p.id)
            return pp && p.pts > pp.pts
          })
          setScoringPlayerId(scorer?.id ?? null)
          setTimeout(() => { setScoringPlayerId(null); setScoringTricode(null) }, 2000)
        }
      }

      // Set the clock anchor so the local ticker can interpolate smoothly
      const isGameLive = msg.gameStatus === 2
      const clockIsZero = msg.clock === "PT00M00.00S" || !msg.clock
      const clockChanged = !clockAnchorRef.current || msg.clock !== clockAnchorRef.current.lastClockStr
      clockAnchorRef.current = {
        seconds: clockToSeconds(msg.clock),
        receivedAt: Date.now(),
        running: isGameLive && !clockIsZero && clockChanged,
        lastClockStr: msg.clock
      }

      prevDataRef.current = msg
      setData(msg)
    }

    chrome.runtime.onMessage.addListener(handleMessage)

    // Tick every 100ms to smoothly count the clock down between API updates
    const ticker = setInterval(() => {
      const anchor = clockAnchorRef.current
      if (!anchor || !anchor.running) return
      const elapsed = (Date.now() - anchor.receivedAt) / 1000
      const current = Math.max(0, anchor.seconds - elapsed)
      setDisplayClock(secondsToDisplay(current))
      if (current <= 0) clockAnchorRef.current = { ...anchor, running: false }
    }, 100)

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage)
      document.removeEventListener("mousedown", handleClickOutside)
      clearInterval(ticker)
    }
  }, [])

  if (!data || displayMode === "off") return null

  // ── STATBUG MODE (Top Bar) ────────────────────────────────────────────────────
  if (displayMode === "statbug") {
    const awayColor = NBA_COLORS[data.awayTeam.tricode] || "#333"
    const homeColor = NBA_COLORS[data.homeTeam.tricode] || "#333"

    // Small pill badge used for position and jersey number
    const Pill = ({ text }: { text: string }) => (
      <span style={{
        fontSize: "8px", fontWeight: 800,
        color: "rgba(255,255,255,0.6)",
        backgroundColor: "rgba(0,0,0,0.4)",
        borderRadius: "3px", padding: "1px 4px",
        flexShrink: 0, letterSpacing: "0.3px"
      }}>{text}</span>
    )

    // Timeout dots — filled yellow up to the number of timeouts remaining
    const TimeoutDots = ({ count }: { count: number }) => (
      <div style={{ display: "flex", gap: "3px", alignItems: "center" }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} style={{
            width: "6px", height: "6px", borderRadius: "50%",
            backgroundColor: i < count ? "#ffdd00" : "rgba(255,255,255,0.2)",
            transition: "background-color 0.4s"
          }} />
        ))}
      </div>
    )

    // Slide-down team stats drawer — shows full team shooting and misc stats
    const TeamStatsDrawer = ({ team, color }: { team: any, color: string }) => {
      const s = team.teamStats
      // Stats shown in a 3-column grid inside the drawer
      const rows = [
        { label: "FG", value: `${s.fgm}/${s.fga}` },
        { label: "FG%", value: s.fgPct },
        { label: "3PM", value: `${s.tpm}/${s.tpa}` },
        { label: "3P%", value: s.tpPct },
        { label: "FT", value: `${s.ftm}/${s.fta}` },
        { label: "FT%", value: s.ftPct },
        { label: "REB", value: s.reb },
        { label: "OREB", value: s.oreb },
        { label: "DREB", value: s.dreb },
        { label: "AST", value: s.ast },
        { label: "TOV", value: s.tov },
        { label: "STL", value: s.stl },
        { label: "BLK", value: s.blk },
        { label: "PITP", value: s.pitp },
        { label: "FB PTS", value: s.fastBreak },
        { label: "2nd CH", value: s.secondChance },
        { label: "BENCH", value: s.benchPts },
      ]
      return (
        <div style={{
          backgroundColor: `${color}ee`,
          backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.5) 100%)`,
          borderTop: "1px solid rgba(255,255,255,0.12)",
          padding: "10px 10px 8px",
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: "4px 6px"
        }}>
          {rows.map(({ label, value }) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.5)", fontWeight: 700 }}>{label}</span>
              <span style={{ fontSize: "12px", fontWeight: 800, color: "white", textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}>{value ?? "-"}</span>
            </div>
          ))}
        </div>
      )
    }

    // Renders the 5 player cards for one team
    const renderTeamPlayers = (players: any[], teamColor: string) =>
      players.map((p: any, i: number) => {
        const isScorer = scoringPlayerId === p.id
        const isExpanded = expandedPlayerId === p.id
        const cardBg = i % 2 === 0 ? `${teamColor}ff` : `${teamColor}ee`

        return (
          <div key={p.id} style={{
            display: "flex", flexDirection: "column",
            flex: "1 1 0", minWidth: 0, position: "relative",
            borderRight: "1px solid rgba(0,0,0,0.4)"
          }}>
            {/* Clickable player card row */}
            <div
              onClick={() => setExpandedPlayerId(isExpanded ? null : p.id)}
              style={{
                display: "flex", flexDirection: "row", alignItems: "center",
                height: "75px", overflow: "hidden", cursor: "pointer",
                backgroundColor: isExpanded ? `${teamColor}ff` : isScorer ? `${teamColor}ff` : cardBg,
                backgroundImage: isExpanded || isScorer
                  ? `linear-gradient(160deg, rgba(255,221,0,0.18) 0%, transparent 60%), linear-gradient(to bottom, rgba(255,255,255,0.08) 0%, rgba(0,0,0,0.25) 100%)`
                  : `linear-gradient(160deg, rgba(255,255,255,0.07) 0%, transparent 55%), linear-gradient(to bottom, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.2) 100%)`,
                transition: "background-color 0.3s ease"
              }}>

              {/* Left accent bar — gold when scoring, white when expanded */}
              <div style={{
                width: "3px", alignSelf: "stretch", flexShrink: 0,
                backgroundColor: isExpanded ? "#ffffff" : isScorer ? "#ffdd00" : "rgba(255,255,255,0.2)",
                transition: "background-color 0.3s"
              }} />

              {/* Player headshot from NBA CDN */}
              <img
                src={`https://cdn.nba.com/headshots/nba/latest/260x190/${p.id}.png`}
                style={{
                  height: "70px", width: "55px", objectFit: "cover",
                  objectPosition: "top center", flexShrink: 0,
                  filter: isScorer ? "drop-shadow(0 0 6px #ffdd00)" : "drop-shadow(0 1px 3px rgba(0,0,0,0.8))",
                  transition: "filter 0.3s"
                }}
                alt=""
                onError={(e) => { e.currentTarget.style.display = "none" }}
              />

              {/* Text block: name row + PTS/REB row + AST/PF row */}
              <div style={{
                display: "flex", flexDirection: "column", justifyContent: "center",
                paddingLeft: "5px", paddingRight: "3px", minWidth: 0, flex: 1, gap: "2px"
              }}>
                {/* Row 1: Name + jersey number pill + position pill */}
                <div style={{ display: "flex", alignItems: "center", gap: "3px", minWidth: 0 }}>
                  <span style={{
                    fontSize: "11px", fontWeight: 900,
                    color: isScorer ? "#ffdd00" : "white",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    textTransform: "uppercase", letterSpacing: "0.2px",
                    textShadow: "0 1px 3px rgba(0,0,0,1)", lineHeight: 1, flex: 1, minWidth: 0
                  }}>{p.name}</span>
                  {p.number && <Pill text={`#${p.number}`} />}
                  {p.position && <Pill text={p.position} />}
                </div>

                {/* Row 2: Points + Rebounds */}
                <div style={{ display: "flex", gap: "4px", alignItems: "baseline" }}>
                  <span style={{
                    fontSize: "18px", fontWeight: 900,
                    color: isScorer ? "#00ff00" : "white",
                    lineHeight: 1, textShadow: "0 1px 3px rgba(0,0,0,0.9)",
                    animation: isScorer ? "ptsPulse 0.6s ease-out" : "none"
                  }}>{p.pts}</span>
                  <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.55)", fontWeight: 700, marginRight: "2px" }}>PTS</span>
                  <span style={{ fontSize: "15px", fontWeight: 800, color: "rgba(255,255,255,0.9)", lineHeight: 1, textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}>{p.reb}</span>
                  <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.55)", fontWeight: 700 }}>REB</span>
                </div>

                {/* Row 3: Assists + Personal Fouls (colour-coded at 4 and 5) */}
                <div style={{ display: "flex", gap: "4px", alignItems: "baseline" }}>
                  <span style={{ fontSize: "15px", fontWeight: 800, color: "rgba(255,255,255,0.9)", lineHeight: 1, textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}>{p.ast}</span>
                  <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.55)", fontWeight: 700, marginRight: "2px" }}>AST</span>
                  <span style={{
                    fontSize: "15px", fontWeight: 800, lineHeight: 1,
                    color: p.fouls >= 5 ? "#ff4757" : p.fouls >= 4 ? "#ffdd00" : "rgba(255,255,255,0.9)",
                    textShadow: "0 1px 3px rgba(0,0,0,0.9)"
                  }}>{p.fouls}</span>
                  <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.55)", fontWeight: 700 }}>PF</span>
                </div>
              </div>

              {/* Chevron rotates when the card is expanded */}
              <span style={{
                fontSize: "10px", color: "rgba(255,255,255,0.4)",
                paddingRight: "4px", flexShrink: 0,
                transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 0.2s"
              }}>▼</span>
            </div>

            {/* Detailed stats dropdown — slides down when card is expanded */}
            {isExpanded && (
              <div style={{
                position: "absolute", top: "75px", left: 0, right: 0,
                backgroundColor: `${teamColor}f0`,
                backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.5) 100%)`,
                borderTop: "1px solid rgba(255,255,255,0.15)",
                borderBottom: "1px solid rgba(0,0,0,0.5)",
                padding: "8px", zIndex: 10,
                display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 8px"
              }}>
                {[
                  { label: "MIN", value: p.min },
                  { label: "FG", value: `${p.fgm}/${p.fga}` },
                  { label: "3PT", value: `${p.tpm}/${p.tpa}` },
                  { label: "FT", value: `${p.ftm}/${p.fta}` },
                  { label: "OREB", value: p.oreb },
                  { label: "STL", value: p.stl },
                  { label: "BLK", value: p.blk },
                  { label: "TO", value: p.tov },
                  { label: "+/-", value: p.plusMinus > 0 ? `+${p.plusMinus}` : p.plusMinus },
                ].map(({ label, value }) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "4px" }}>
                    <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.5)", fontWeight: 700 }}>{label}</span>
                    <span style={{ fontSize: "13px", fontWeight: 800, color: "white", textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}>{value ?? "-"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })

    // The play clock label e.g. "Q3 4:22"
    const playClockLabel = formatPlayClock(data.latestPlayClock, data.latestPlayPeriod)

    return (
      <div ref={statBugRef} style={{
        position: "fixed", top: 0, left: 0, right: 0,
        color: "white", fontFamily: "'Arial Black', Arial, sans-serif",
        display: "flex", flexDirection: "column",
        zIndex: 2147483647, pointerEvents: "none",
        boxShadow: "0 6px 30px rgba(0,0,0,0.9)"
      }}>

        {/* ── Row 1: Player cards ── */}
        <div style={{ display: "flex", alignItems: "flex-start", height: "75px" }}>
          {/* Away team players */}
          <div style={{ display: "flex", flex: 1, minWidth: 0, pointerEvents: "auto", alignSelf: "flex-start" }}>
            {renderTeamPlayers(data.awayTeam.onCourt || [], awayColor)}
          </div>
          {/* Divider between teams */}
          <div style={{ width: "4px", backgroundColor: "#000", flexShrink: 0, height: "75px" }} />
          {/* Home team players */}
          <div style={{ display: "flex", flex: 1, minWidth: 0, pointerEvents: "auto", alignSelf: "flex-start" }}>
            {renderTeamPlayers(data.homeTeam.onCourt || [], homeColor)}
          </div>
        </div>

        {/* ── Row 2: Bottom info strip ── */}
        {/* Left quarter: away team tab (click to open team stats drawer) */}
        {/* Middle half: play-by-play ticker with game clock */}
        {/* Right quarter: home team tab */}
        <div style={{ display: "flex", height: "28px", pointerEvents: "auto" }}>

          {/* Away team tab — shows team name, foul count or BONUS, timeout dots */}
          <div
            onClick={() => setExpandedTeamStats(prev => {
              const next = new Set(prev)
              // Toggle: if already open close it, if closed open it
              next.has("away") ? next.delete("away") : next.add("away")
              return next
            })}
            style={{
              flex: 1, display: "flex", alignItems: "center", gap: "6px",
              padding: "0 10px", cursor: "pointer",
              backgroundColor: expandedTeamStats.has("away") ? `${awayColor}ff` : `${awayColor}cc`,
              backgroundImage: `linear-gradient(160deg, rgba(255,255,255,0.07) 0%, transparent 55%), linear-gradient(to bottom, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.2) 100%)`,
              borderTop: "1px solid rgba(255,255,255,0.1)",
              transition: "background-color 0.2s"
            }}>
            <span style={{ fontSize: "10px", fontWeight: 900, color: "white", whiteSpace: "nowrap" }}>
              {data.awayTeam.tricode}
            </span>
            {/* Foul count — turns red if in bonus */}
            <span style={{
              fontSize: "9px", fontWeight: 700,
              color: data.awayTeam.inBonus ? "#ff4757" : "rgba(255,255,255,0.7)",
              whiteSpace: "nowrap"
            }}>
              {data.awayTeam.inBonus ? "BONUS" : `${data.awayTeam.fouls}F`}
            </span>
            <TimeoutDots count={data.awayTeam.timeouts} />
            {/* Chevron indicates the drawer can be toggled */}
            <span style={{
              fontSize: "8px", color: "rgba(255,255,255,0.4)", marginLeft: "auto",
              transform: expandedTeamStats.has("away") ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 0.2s"
            }}>▲</span>
          </div>

          {/* Middle: play-by-play ticker */}
          <div style={{
            flex: 2, display: "flex", alignItems: "center", justifyContent: "center",
            gap: "8px", backgroundColor: "rgba(0,0,0,0.85)",
            borderTop: "1px solid #222", padding: "0 8px", overflow: "hidden"
          }}>
            <span style={{ color: "#ff4757", fontSize: "9px", fontWeight: 900, flexShrink: 0 }}>PLAY</span>
            {/* Game clock label for when this play happened */}
            {playClockLabel && (
              <span style={{
                fontSize: "9px", fontWeight: 700,
                color: "rgba(255,255,255,0.45)", flexShrink: 0
              }}>{playClockLabel}</span>
            )}
            <span style={{
              fontSize: "10px", color: "rgba(255,255,255,0.85)",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
            }}>{data.latestPlay}</span>
          </div>

          {/* Home team tab — same layout as away but mirrored */}
          <div
            onClick={() => setExpandedTeamStats(prev => {
              const next = new Set(prev)
              next.has("home") ? next.delete("home") : next.add("home")
              return next
            })}
            style={{
              flex: 1, display: "flex", alignItems: "center", gap: "6px",
              padding: "0 10px", cursor: "pointer", justifyContent: "flex-end",
              backgroundColor: expandedTeamStats.has("home") ? `${homeColor}ff` : `${homeColor}cc`,
              backgroundImage: `linear-gradient(160deg, rgba(255,255,255,0.07) 0%, transparent 55%), linear-gradient(to bottom, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.2) 100%)`,
              borderTop: "1px solid rgba(255,255,255,0.1)",
              transition: "background-color 0.2s"
            }}>
            <span style={{
              fontSize: "8px", color: "rgba(255,255,255,0.4)", marginRight: "auto",
              transform: expandedTeamStats.has("home") ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 0.2s"
            }}>▲</span>
            <TimeoutDots count={data.homeTeam.timeouts} />
            <span style={{
              fontSize: "9px", fontWeight: 700,
              color: data.homeTeam.inBonus ? "#ff4757" : "rgba(255,255,255,0.7)",
              whiteSpace: "nowrap"
            }}>
              {data.homeTeam.inBonus ? "BONUS" : `${data.homeTeam.fouls}F`}
            </span>
            <span style={{ fontSize: "10px", fontWeight: 900, color: "white", whiteSpace: "nowrap" }}>
              {data.homeTeam.tricode}
            </span>
          </div>
        </div>

        {/* ── Row 3: Team stats drawers ── */}
        {/* Each team occupies exactly half the screen width when open */}
        {/* Both can be open at once, both close when clicking outside */}
        {expandedTeamStats.size > 0 && (
          <div style={{ display: "flex", pointerEvents: "auto" }}>
            {/* Away drawer — always on the left half */}
            <div style={{ flex: 1, overflow: "hidden" }}>
              {expandedTeamStats.has("away") && (
                <TeamStatsDrawer team={data.awayTeam} color={awayColor} />
              )}
            </div>
            {/* Home drawer — always on the right half */}
            <div style={{ flex: 1, overflow: "hidden" }}>
              {expandedTeamStats.has("home") && (
                <TeamStatsDrawer team={data.homeTeam} color={homeColor} />
              )}
            </div>
          </div>
        )}

        <style>{`
          @keyframes ptsPulse {
            0% { transform: scale(1); }
            40% { transform: scale(1.3); color: #00ff00; }
            100% { transform: scale(1); }
          }
        `}</style>
      </div>
    )
  }

  // ── SCOREBUG MODE (Bottom Bar) ────────────────────────────────────────────────

  // Timeout indicators shown under the score
  const renderTimeouts = (count: number) =>
    Array.from({ length: 7 }).map((_, i) => (
      <div key={i} style={{
        height: "4px", width: "12px", borderRadius: "2px", margin: "0 2px",
        backgroundColor: i < count ? "#ffdd00" : "rgba(255,255,255,0.2)",
        transition: "background-color 0.5s ease"
      }} />
    ))

  // One half of the scorebug — mirrored for away vs home
  const TeamSide = ({ team, isAway }: { team: any, isAway: boolean }) => {
    const teamColor = NBA_COLORS[team.tricode] || "#333"
    const isScoring = scoringTricode === team.tricode
    const bgGradient = isAway
      ? `linear-gradient(to left, ${teamColor}DD, ${teamColor}22)`
      : `linear-gradient(to right, ${teamColor}DD, ${teamColor}22)`

    return (
      <div style={{ flex: 1, display: "flex", flexDirection: isAway ? "row" : "row-reverse", background: bgGradient, alignItems: "center" }}>
        <div style={{ flex: 1, display: "flex", justifyContent: "space-evenly", alignItems: "center", padding: "0 10px" }}>
          {team.onCourt?.map((p: any) => {
            const isScorer = scoringPlayerId === p.id
            return (
              <div key={p.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "85px" }}>
                <img
                  src={`https://cdn.nba.com/headshots/nba/latest/260x190/${p.id}.png`}
                  style={{
                    height: "60px", width: "75px", objectFit: "cover", objectPosition: "top",
                    borderBottom: "1px solid rgba(255,255,255,0.2)",
                    filter: isScorer ? "drop-shadow(0 0 8px #ffdd00)" : "none",
                    transition: "filter 0.3s ease"
                  }}
                  alt=""
                  onError={(e) => { e.currentTarget.src = "https://cdn.nba.com/headshots/nba/latest/260x190/fallback.png" }}
                />
                <span style={{
                  fontSize: "12px", fontWeight: "bold", marginTop: "6px",
                  textShadow: "0 1px 2px #000",
                  color: isScorer ? "#ffdd00" : "white",
                  transition: "color 0.3s ease"
                }}>{p.name}</span>
                <div style={{
                  fontSize: "11px",
                  color: isScorer ? "#00ff00" : "#ddd",
                  animation: isScorer ? "playerUpdate 0.8s ease-out" : "none",
                  transition: "color 0.3s ease"
                }}>
                  {p.pts}P {p.reb}R {p.ast}A
                </div>
              </div>
            )
          })}
        </div>
        <div style={{ width: "2px", height: "60%", backgroundColor: "rgba(255,255,255,0.1)", margin: "0 10px" }} />
        <div style={{ display: "flex", flexDirection: isAway ? "row" : "row-reverse", alignItems: "center", padding: "0 20px", minWidth: "220px", justifyContent: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: isAway ? "flex-end" : "flex-start", margin: isAway ? "0 15px 0 0" : "0 0 0 15px" }}>
            <div style={{ display: "flex", alignItems: "baseline", flexDirection: isAway ? "row" : "row-reverse", gap: "10px" }}>
              <span style={{ fontSize: "18px", fontWeight: 800, color: "#fff" }}>{team.tricode}</span>
              <span style={{
                fontSize: "48px", fontWeight: 900, color: "white",
                animation: isScoring ? "scorePulse 0.6s ease-out" : "none"
              }}>{team.score}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px", flexDirection: isAway ? "row" : "row-reverse" }}>
              <span style={{ fontSize: "11px", fontWeight: "bold", color: team.inBonus ? "#ff4757" : "#aaa" }}>
                {team.inBonus ? "BONUS" : `FOULS: ${team.fouls}`}
              </span>
              <div style={{ display: "flex" }}>{renderTimeouts(team.timeouts)}</div>
            </div>
          </div>
          <img
            src={`https://a.espncdn.com/i/teamlogos/nba/500/${team.tricode.toLowerCase()}.png`}
            style={{ height: "65px", width: "65px" }}
          />
        </div>
      </div>
    )
  }

  // Bottom scorebug container
  return (
    <div style={{
      position: "fixed", bottom: "4%", left: "50%", transform: "translateX(-50%)",
      display: "flex", flexDirection: "column", backgroundColor: "rgba(10, 10, 14, 0.98)",
      color: "white", borderRadius: "12px", boxShadow: "0 20px 60px rgba(0,0,0,0.9)",
      width: "85vw", maxWidth: "1600px", fontFamily: "sans-serif", pointerEvents: "none",
      overflow: "hidden", zIndex: 2147483647,
      animation: "slideUp 0.5s cubic-bezier(0.17, 0.67, 0.83, 0.67)"
    }}>
      <div style={{ display: "flex", height: "120px", width: "100%" }}>
        <TeamSide team={data.awayTeam} isAway={true} />
        <div style={{
          display: "flex", flexDirection: "column", justifyContent: "center",
          alignItems: "center", padding: "0 30px", backgroundColor: "#000", minWidth: "130px"
        }}>
          <span style={{ fontSize: "14px", fontWeight: "bold", color: data.gameStatus === 3 ? "orange" : "#00ff00" }}>
            {data.gameStatus === 3 ? "FINAL" : `Q${data.period}`}
          </span>
          <span style={{ fontSize: "32px", fontWeight: 700, fontFamily: "monospace" }}>
            {data.gameStatus === 3 ? "" : (displayClock || formatClock(data.clock))}
          </span>
        </div>
        <TeamSide team={data.homeTeam} isAway={false} />
      </div>
      <div style={{
        width: "100%", height: "36px", backgroundColor: "#000",
        display: "flex", alignItems: "center", justifyContent: "center",
        borderTop: "1px solid #333"
      }}>
        <span style={{ color: "#ff4757", marginRight: "12px", fontSize: "12px", fontWeight: "bold" }}>PLAY</span>
        <span style={{ fontSize: "12px" }}>{data.latestPlay}</span>
      </div>
      <style>{`
        @keyframes scorePulse {
          0% { transform: scale(1); }
          50% { transform: scale(1.15); color: #ffdd00; text-shadow: 0 0 15px #ffdd00; }
          100% { transform: scale(1); }
        }
        @keyframes playerUpdate {
          0% { transform: translateY(0); }
          30% { transform: translateY(-3px); }
          100% { transform: translateY(0); }
        }
        @keyframes slideUp {
          from { transform: translateX(-50%) translateY(100%); opacity: 0; }
          to { transform: translateX(-50%) translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  )
}