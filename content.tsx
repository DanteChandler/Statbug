import { useEffect, useState, useRef } from "react"
import type { PlasmoCSConfig, PlasmoGetRootContainer } from "plasmo"

// Inject this content script only on NBA.com pages
export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"]
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

// Primary colour for each NBA team
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

type DisplayMode = "off" | "scorebug" | "statbug"

// Which stat is currently being highlighted on a player, and what type of event triggered it
type StatEvent = {
  playerId: string
  stat: "blk" | "stl" | "tov" | "foul4" | "foul5"
  expiresAt: number
}

// Formats an ISO clock string into a readable "Q3 5:30" label
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
  const [data, setData] = useState<any>(null)
  const [displayMode, setDisplayMode] = useState<DisplayMode>("scorebug")
  const [displayClock, setDisplayClock] = useState<string>("")
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null)
  const [expandedTeamStats, setExpandedTeamStats] = useState<Set<string>>(new Set())

  // Scoring animation — which player and team just scored
  const [scoringPlayerId, setScoringPlayerId] = useState<string | null>(null)
  const [scoringTricode, setScoringTricode] = useState<string | null>(null)

  // Stat event animation — tracks the most recent non-scoring stat event per player
  // Key is playerId, value is the active event
  const [statEvents, setStatEvents] = useState<Map<string, StatEvent>>(new Map())

  // Rebound/assist flash — brief positive animation
  const [rebFlashId, setRebFlashId] = useState<string | null>(null)
  const [astFlashId, setAstFlashId] = useState<string | null>(null)

  // Window width for compact mode detection — compact below 900px
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)

  const prevDataRef = useRef<any>(null)
  const clockAnchorRef = useRef<{
    seconds: number
    receivedAt: number
    running: boolean
    lastClockStr: string
  } | null>(null)
  const statBugRef = useRef<HTMLDivElement>(null)
  // Timers for stat events so we can reset them on repeat events
  const statEventTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const clockToSeconds = (clockStr: string): number => {
    if (!clockStr) return 0
    const match = clockStr.match(/PT(\d+)M(\d+\.?\d*)S/)
    if (!match) return 0
    return parseInt(match[1]) * 60 + parseFloat(match[2])
  }

  const secondsToDisplay = (secs: number): string => {
    if (secs <= 0) return "0:00"
    const m = Math.floor(secs / 60)
    const s = secs % 60
    if (m === 0) return s.toFixed(1)
    return `${m}:${Math.floor(s).toString().padStart(2, "0")}`
  }

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

  // Triggers a stat event on a player — resets the 10s timer if they already have one
  const triggerStatEvent = (playerId: string, stat: StatEvent["stat"]) => {
    // Clear existing timer for this player if there is one
    const existing = statEventTimers.current.get(playerId)
    if (existing) clearTimeout(existing)

    const expiresAt = Date.now() + 10000
    setStatEvents(prev => new Map(prev).set(playerId, { playerId, stat, expiresAt }))

    // Auto-clear after 10 seconds
    const timer = setTimeout(() => {
      setStatEvents(prev => {
        const next = new Map(prev)
        next.delete(playerId)
        return next
      })
      statEventTimers.current.delete(playerId)
    }, 10000)
    statEventTimers.current.set(playerId, timer)
  }

  useEffect(() => {
    // Track window width for compact mode
    const handleResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener("resize", handleResize)

    try {
      chrome.storage.local.get(["displayMode"], (result) => {
        if (result.displayMode) setDisplayMode(result.displayMode)
      })
    } catch (e) {}

    const handleClickOutside = (e: MouseEvent) => {
      if (statBugRef.current && !statBugRef.current.contains(e.target as Node)) {
        setExpandedPlayerId(null)
        setExpandedTeamStats(new Set())
      }
    }
    document.addEventListener("mousedown", handleClickOutside)

    const handleMessage = (msg: any) => {
      if (msg.type === "SET_DISPLAY_MODE") {
        setDisplayMode(msg.mode)
        return
      }
      if (msg.type !== "UPDATE_BOXSCORE") return

      const prev = prevDataRef.current

      if (prev) {
        // Helper to detect stat changes on a team's on-court players
        const detectStatChanges = (currTeam: any, prevTeam: any) => {
          currTeam.onCourt?.forEach((p: any) => {
            const pp = prevTeam.onCourt?.find((x: any) => x.id === p.id)
            if (!pp) return

            // Scoring animation
            if (p.pts > pp.pts) {
              setScoringTricode(currTeam.tricode)
              setScoringPlayerId(p.id)
              setTimeout(() => { setScoringPlayerId(null); setScoringTricode(null) }, 2000)
            }

            // Rebound flash — brief green
            if (p.reb > pp.reb) {
              setRebFlashId(p.id)
              setTimeout(() => setRebFlashId(null), 1500)
            }

            // Assist flash — brief teal
            if (p.ast > pp.ast) {
              setAstFlashId(p.id)
              setTimeout(() => setAstFlashId(null), 1500)
            }

            // Block — triggers rotating 4th stat for 10s
            if (p.blk > pp.blk) triggerStatEvent(p.id, "blk")

            // Steal — triggers rotating 4th stat for 10s
            if (p.stl > pp.stl) triggerStatEvent(p.id, "stl")

            // Turnover — triggers rotating 4th stat for 10s (negative)
            if (p.tov > pp.tov) triggerStatEvent(p.id, "tov")

            // Foul danger (4th foul)
            if (p.fouls === 4 && pp.fouls < 4) triggerStatEvent(p.id, "foul4")

            // Fouled out (5th foul)
            if (p.fouls >= 5 && pp.fouls < 5) triggerStatEvent(p.id, "foul5")
          })
        }

        detectStatChanges(msg.awayTeam, prev.awayTeam)
        detectStatChanges(msg.homeTeam, prev.homeTeam)
      }

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
      window.removeEventListener("resize", handleResize)
      clearInterval(ticker)
      // Clear all stat event timers on unmount
      statEventTimers.current.forEach(t => clearTimeout(t))
    }
  }, [])

  if (!data || displayMode === "off") return null

  // ── STATBUG MODE ─────────────────────────────────────────────────────────────
  if (displayMode === "statbug") {
    const awayColor = NBA_COLORS[data.awayTeam.tricode] || "#333"
    const homeColor = NBA_COLORS[data.homeTeam.tricode] || "#333"

    // Compact mode kicks in below 900px — switches to vertical card layout
    const isCompact = windowWidth < 900

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

    const TeamStatsDrawer = ({ team, color }: { team: any, color: string }) => {
      const s = team.teamStats
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
          gap: "4px 6px",
          boxShadow: "0 6px 20px rgba(0,0,0,0.8)"
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

    const renderTeamPlayers = (players: any[], teamColor: string) =>
      players.map((p: any, i: number) => {
        const isScorer = scoringPlayerId === p.id
        const isExpanded = expandedPlayerId === p.id
        const isRebFlash = rebFlashId === p.id
        const isAstFlash = astFlashId === p.id
        const activeEvent = statEvents.get(p.id)
        const cardBg = i % 2 === 0 ? `${teamColor}ff` : `${teamColor}ee`

        // The 4th stat rotates based on active event — defaults to PF
        const fourthStat = activeEvent
          ? {
              blk: { label: "BLK", value: p.blk, color: "#00ff00", anim: "statGreenPulse 0.5s ease-out" },
              stl: { label: "STL", value: p.stl, color: "#00ff00", anim: "statGreenPulse 0.5s ease-out" },
              tov: { label: "TOV", value: p.tov, color: "#ff4757", anim: "statRedPulse 0.5s ease-out" },
              foul4: { label: "PF", value: p.fouls, color: "#ffdd00", anim: "statYellowPulse 0.5s ease-out" },
              foul5: { label: "PF", value: p.fouls, color: "#ff4757", anim: "statRedPulse 0.5s ease-out" },
            }[activeEvent.stat]
          : { label: "PF", value: p.fouls, color: p.fouls >= 5 ? "#ff4757" : p.fouls >= 4 ? "#ffdd00" : "rgba(255,255,255,0.9)", anim: "none" }

        // ── COMPACT CARD (vertical layout, used when window < 900px) ──
        if (isCompact) {
          return (
            <div key={p.id} style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              flex: "1 1 0", minWidth: 0, position: "relative",
              borderRight: "1px solid rgba(0,0,0,0.4)",
              cursor: "pointer",
              backgroundColor: isExpanded ? `${teamColor}ff` : isScorer ? `${teamColor}ff` : cardBg,
              backgroundImage: isExpanded || isScorer
                ? `linear-gradient(160deg, rgba(255,221,0,0.18) 0%, transparent 60%), linear-gradient(to bottom, rgba(255,255,255,0.08) 0%, rgba(0,0,0,0.25) 100%)`
                : `linear-gradient(160deg, rgba(255,255,255,0.07) 0%, transparent 55%), linear-gradient(to bottom, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.2) 100%)`,
              // Top accent bar instead of left — gold when scoring
              borderTop: `2px solid ${isScorer ? "#ffdd00" : isExpanded ? "#fff" : "transparent"}`,
              overflow: "hidden",
              paddingBottom: "3px"
            }}
              onClick={() => setExpandedPlayerId(isExpanded ? null : p.id)}
            >
              {/* Name — truncated */}
              <span style={{
                fontSize: "9px", fontWeight: 900,
                color: isScorer ? "#ffdd00" : "white",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                textTransform: "uppercase", letterSpacing: "0.2px",
                textShadow: "0 1px 3px rgba(0,0,0,1)", lineHeight: 1,
                width: "100%", textAlign: "center", padding: "2px 2px 0"
              }}>{p.name}</span>

              {/* Headshot — fills width */}
              <div style={{ position: "relative", width: "100%", flexShrink: 0 }}>
                <img
                  src={`https://cdn.nba.com/headshots/nba/latest/260x190/${p.id}.png`}
                  style={{
                    width: "100%", height: "45px",
                    objectFit: "cover", objectPosition: "top center", display: "block",
                    filter: isScorer ? "drop-shadow(0 0 6px #ffdd00)" : "drop-shadow(0 1px 3px rgba(0,0,0,0.8))",
                    transition: "filter 0.3s"
                  }}
                  alt=""
                  onError={(e) => { e.currentTarget.style.display = "none" }}
                />
                {/* Jersey badge — bottom left */}
                {p.number && (
                  <span style={{
                    position: "absolute", bottom: "1px", left: "1px",
                    fontSize: "7px", fontWeight: 800, color: "white",
                    backgroundColor: "rgba(0,0,0,0.75)",
                    borderRadius: "2px", padding: "0px 2px", lineHeight: 1
                  }}>#{p.number}</span>
                )}
                {/* Position badge — bottom right */}
                {p.position && (
                  <span style={{
                    position: "absolute", bottom: "1px", right: "1px",
                    fontSize: "7px", fontWeight: 800, color: "white",
                    backgroundColor: "rgba(0,0,0,0.75)",
                    borderRadius: "2px", padding: "0px 2px", lineHeight: 1
                  }}>{p.position}</span>
                )}
              </div>

              {/* Row: PTS + REB */}
              <div style={{ display: "flex", gap: "3px", alignItems: "baseline", padding: "1px 2px 0" }}>
                <span style={{
                  fontSize: "13px", fontWeight: 900,
                  color: isScorer ? "#00ff00" : isRebFlash ? "white" : "white",
                  lineHeight: 1, textShadow: "0 1px 3px rgba(0,0,0,0.9)",
                  animation: isScorer ? "ptsPulse 0.6s ease-out" : "none"
                }}>{p.pts}</span>
                <span style={{ fontSize: "7px", color: "rgba(255,255,255,0.5)", fontWeight: 700 }}>P</span>
                <span style={{
                  fontSize: "11px", fontWeight: 800,
                  color: isRebFlash ? "#00cc88" : "rgba(255,255,255,0.9)",
                  lineHeight: 1, textShadow: "0 1px 3px rgba(0,0,0,0.9)",
                  animation: isRebFlash ? "statGreenPulse 0.5s ease-out" : "none"
                }}>{p.reb}</span>
                <span style={{ fontSize: "7px", color: "rgba(255,255,255,0.5)", fontWeight: 700 }}>R</span>
              </div>

              {/* Row: AST + rotating 4th stat */}
              <div style={{ display: "flex", gap: "3px", alignItems: "baseline", padding: "0 2px" }}>
                <span style={{
                  fontSize: "11px", fontWeight: 800,
                  color: isAstFlash ? "#00ccff" : "rgba(255,255,255,0.9)",
                  lineHeight: 1, textShadow: "0 1px 3px rgba(0,0,0,0.9)",
                  animation: isAstFlash ? "statBluePulse 0.5s ease-out" : "none"
                }}>{p.ast}</span>
                <span style={{ fontSize: "7px", color: "rgba(255,255,255,0.5)", fontWeight: 700 }}>A</span>
                <span style={{
                  fontSize: "11px", fontWeight: 800, lineHeight: 1,
                  color: fourthStat.color,
                  textShadow: "0 1px 3px rgba(0,0,0,0.9)",
                  animation: fourthStat.anim
                }}>{fourthStat.value}</span>
                <span style={{ fontSize: "7px", color: "rgba(255,255,255,0.5)", fontWeight: 700 }}>{fourthStat.label}</span>
              </div>

              {/* Expanded dropdown */}
              {isExpanded && (
                <div style={{
                  position: "absolute", top: "100%", left: 0, right: 0,
                  backgroundColor: `${teamColor}f0`,
                  backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.5) 100%)`,
                  borderTop: "1px solid rgba(255,255,255,0.15)",
                  padding: "6px", zIndex: 10,
                  display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 6px"
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
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ fontSize: "8px", color: "rgba(255,255,255,0.5)", fontWeight: 700 }}>{label}</span>
                      <span style={{ fontSize: "11px", fontWeight: 800, color: "white" }}>{value ?? "-"}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        }

        // ── STANDARD CARD (horizontal layout, used when window >= 900px) ──
        return (
          <div key={p.id} style={{
            display: "flex", flexDirection: "column",
            flex: "1 1 0", minWidth: 0, position: "relative",
            borderRight: "1px solid rgba(0,0,0,0.4)"
          }}>
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

              {/* Left accent bar */}
              <div style={{
                width: "3px", alignSelf: "stretch", flexShrink: 0,
                backgroundColor: isExpanded ? "#ffffff" : isScorer ? "#ffdd00" : "rgba(255,255,255,0.2)",
                transition: "background-color 0.3s"
              }} />

              {/* Headshot with badges */}
              <div style={{ position: "relative", flexShrink: 0, height: "70px", width: "55px" }}>
                <img
                  src={`https://cdn.nba.com/headshots/nba/latest/260x190/${p.id}.png`}
                  style={{
                    height: "70px", width: "55px", objectFit: "cover",
                    objectPosition: "top center",
                    filter: isScorer ? "drop-shadow(0 0 6px #ffdd00)" : "drop-shadow(0 1px 3px rgba(0,0,0,0.8))",
                    transition: "filter 0.3s", display: "block"
                  }}
                  alt=""
                  onError={(e) => { e.currentTarget.style.display = "none" }}
                />
                {p.number && (
                  <span style={{
                    position: "absolute", bottom: "2px", left: "2px",
                    fontSize: "8px", fontWeight: 800, color: "white",
                    backgroundColor: "rgba(0,0,0,0.75)",
                    borderRadius: "3px", padding: "1px 3px", letterSpacing: "0.3px", lineHeight: 1
                  }}>#{p.number}</span>
                )}
                {p.position && (
                  <span style={{
                    position: "absolute", bottom: "2px", right: "2px",
                    fontSize: "8px", fontWeight: 800, color: "white",
                    backgroundColor: "rgba(0,0,0,0.75)",
                    borderRadius: "3px", padding: "1px 3px", letterSpacing: "0.3px", lineHeight: 1
                  }}>{p.position}</span>
                )}
              </div>

              {/* Text block */}
              <div style={{
                display: "flex", flexDirection: "column", justifyContent: "center",
                paddingLeft: "5px", paddingRight: "3px", minWidth: 0, flex: 1, gap: "2px"
              }}>
                {/* Name */}
                <span style={{
                  fontSize: "11px", fontWeight: 900,
                  color: isScorer ? "#ffdd00" : "white",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  textTransform: "uppercase", letterSpacing: "0.2px",
                  textShadow: "0 1px 3px rgba(0,0,0,1)", lineHeight: 1
                }}>{p.name}</span>

                {/* PTS + REB */}
                <div style={{ display: "flex", gap: "4px", alignItems: "baseline" }}>
                  <span style={{
                    fontSize: "18px", fontWeight: 900,
                    color: isScorer ? "#00ff00" : "white",
                    lineHeight: 1, textShadow: "0 1px 3px rgba(0,0,0,0.9)",
                    animation: isScorer ? "ptsPulse 0.6s ease-out" : "none"
                  }}>{p.pts}</span>
                  <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.55)", fontWeight: 700, marginRight: "2px" }}>PTS</span>
                  <span style={{
                    fontSize: "15px", fontWeight: 800, lineHeight: 1,
                    color: isRebFlash ? "#00cc88" : "rgba(255,255,255,0.9)",
                    textShadow: "0 1px 3px rgba(0,0,0,0.9)",
                    animation: isRebFlash ? "statGreenPulse 0.5s ease-out" : "none"
                  }}>{p.reb}</span>
                  <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.55)", fontWeight: 700 }}>REB</span>
                </div>

                {/* AST + rotating 4th stat */}
                <div style={{ display: "flex", gap: "4px", alignItems: "baseline" }}>
                  <span style={{
                    fontSize: "15px", fontWeight: 800, lineHeight: 1,
                    color: isAstFlash ? "#00ccff" : "rgba(255,255,255,0.9)",
                    textShadow: "0 1px 3px rgba(0,0,0,0.9)",
                    animation: isAstFlash ? "statBluePulse 0.5s ease-out" : "none"
                  }}>{p.ast}</span>
                  <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.55)", fontWeight: 700, marginRight: "2px" }}>AST</span>
                  <span style={{
                    fontSize: "15px", fontWeight: 800, lineHeight: 1,
                    color: fourthStat.color,
                    textShadow: "0 1px 3px rgba(0,0,0,0.9)",
                    animation: fourthStat.anim
                  }}>{fourthStat.value}</span>
                  <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.55)", fontWeight: 700 }}>{fourthStat.label}</span>
                </div>
              </div>

              {/* Chevron */}
              <span style={{
                fontSize: "10px", color: "rgba(255,255,255,0.4)",
                paddingRight: "4px", flexShrink: 0,
                transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 0.2s"
              }}>▼</span>
            </div>

            {/* Expanded dropdown */}
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

    const playClockLabel = formatPlayClock(data.latestPlayClock, data.latestPlayPeriod)

    // Card row height differs between compact and standard
    const cardRowHeight = isCompact ? "auto" : "75px"

    return (
      <div ref={statBugRef} style={{
        position: "fixed", top: 0, left: 0, right: 0,
        color: "white", fontFamily: "'Arial Black', Arial, sans-serif",
        display: "flex", flexDirection: "column",
        zIndex: 2147483647, pointerEvents: "none",
      }}>
        {/* ── Row 1: Player cards ── */}
        <div style={{
          display: "flex", alignItems: "flex-start",
          height: cardRowHeight, minHeight: isCompact ? "85px" : "75px",
          boxShadow: "0 4px 20px rgba(0,0,0,0.8)"
        }}>
          <div style={{ display: "flex", flex: 1, minWidth: 0, pointerEvents: "auto", alignSelf: "stretch" }}>
            {renderTeamPlayers(data.awayTeam.onCourt || [], awayColor)}
          </div>
          <div style={{ width: "4px", backgroundColor: "#000", flexShrink: 0, alignSelf: "stretch" }} />
          <div style={{ display: "flex", flex: 1, minWidth: 0, pointerEvents: "auto", alignSelf: "stretch" }}>
            {renderTeamPlayers(data.homeTeam.onCourt || [], homeColor)}
          </div>
        </div>

        {/* ── Row 2: Bottom info strip ── */}
        <div style={{ display: "flex", height: "28px", pointerEvents: "auto", boxShadow: "0 4px 12px rgba(0,0,0,0.7)" }}>
          {/* Away team tab */}
          <div
            onClick={() => setExpandedTeamStats(prev => {
              const next = new Set(prev)
              next.has("away") ? next.delete("away") : next.add("away")
              return next
            })}
            style={{
              flex: 1, display: "flex", alignItems: "center", gap: "6px",
              padding: "0 10px", cursor: "pointer",
              backgroundColor: expandedTeamStats.has("away") ? `${awayColor}ff` : `${awayColor}cc`,
              backgroundImage: `linear-gradient(160deg, rgba(255,255,255,0.07) 0%, transparent 55%), linear-gradient(to bottom, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.2) 100%)`,
              borderTop: "1px solid rgba(255,255,255,0.1)", transition: "background-color 0.2s"
            }}>
            <span style={{ fontSize: "10px", fontWeight: 900, color: "white", whiteSpace: "nowrap" }}>{data.awayTeam.tricode}</span>
            {/* Hide timeout dots in compact mode to save space */}
            {!isCompact && <TimeoutDots count={data.awayTeam.timeouts} />}
            <span style={{ fontSize: "8px", color: "rgba(255,255,255,0.4)", marginLeft: "auto", transform: expandedTeamStats.has("away") ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>▲</span>
          </div>

          {/* Middle play-by-play */}
          <div style={{
            flex: 2, display: "flex", alignItems: "center", justifyContent: "center",
            gap: "8px", backgroundColor: "rgba(0,0,0,0.85)",
            borderTop: "1px solid #222", padding: "0 8px", overflow: "hidden"
          }}>
            <span style={{ color: "#ff4757", fontSize: "9px", fontWeight: 900, flexShrink: 0 }}>PLAY</span>
            {playClockLabel && (
              <span style={{ fontSize: "9px", fontWeight: 700, color: "rgba(255,255,255,0.45)", flexShrink: 0 }}>{playClockLabel}</span>
            )}
            <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.85)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{data.latestPlay}</span>
          </div>

          {/* Home team tab */}
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
              borderTop: "1px solid rgba(255,255,255,0.1)", transition: "background-color 0.2s"
            }}>
            <span style={{ fontSize: "8px", color: "rgba(255,255,255,0.4)", marginRight: "auto", transform: expandedTeamStats.has("home") ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>▲</span>
            {!isCompact && <TimeoutDots count={data.homeTeam.timeouts} />}
            <span style={{ fontSize: "10px", fontWeight: 900, color: "white", whiteSpace: "nowrap" }}>{data.homeTeam.tricode}</span>
          </div>
        </div>

        {/* ── Row 3: Team stats drawers ── */}
        {expandedTeamStats.size > 0 && (
          <div style={{ display: "flex", pointerEvents: "auto" }}>
            <div style={{ flex: 1, overflow: "hidden" }}>
              {expandedTeamStats.has("away")
                ? <TeamStatsDrawer team={data.awayTeam} color={awayColor} />
                : <div style={{ height: expandedTeamStats.has("home") ? "auto" : 0 }} />
              }
            </div>
            <div style={{ flex: 1, overflow: "hidden" }}>
              {expandedTeamStats.has("home")
                ? <TeamStatsDrawer team={data.homeTeam} color={homeColor} />
                : <div style={{ height: expandedTeamStats.has("away") ? "auto" : 0 }} />
              }
            </div>
          </div>
        )}

        <style>{`
          @keyframes ptsPulse {
            0% { transform: scale(1); }
            40% { transform: scale(1.3); color: #00ff00; }
            100% { transform: scale(1); }
          }
          @keyframes statGreenPulse {
            0% { transform: scale(1); }
            40% { transform: scale(1.25); color: #00ff00; text-shadow: 0 0 8px #00ff00; }
            100% { transform: scale(1); }
          }
          @keyframes statRedPulse {
            0% { transform: scale(1); }
            40% { transform: scale(1.25); color: #ff4757; text-shadow: 0 0 8px #ff4757; }
            100% { transform: scale(1); }
          }
          @keyframes statYellowPulse {
            0% { transform: scale(1); }
            40% { transform: scale(1.25); color: #ffdd00; text-shadow: 0 0 8px #ffdd00; }
            100% { transform: scale(1); }
          }
          @keyframes statBluePulse {
            0% { transform: scale(1); }
            40% { transform: scale(1.25); color: #00ccff; text-shadow: 0 0 8px #00ccff; }
            100% { transform: scale(1); }
          }
        `}</style>
      </div>
    )
  }

  // ── SCOREBUG MODE ────────────────────────────────────────────────────────────
  const renderTimeouts = (count: number) =>
    Array.from({ length: 7 }).map((_, i) => (
      <div key={i} style={{
        height: "4px", width: "12px", borderRadius: "2px", margin: "0 2px",
        backgroundColor: i < count ? "#ffdd00" : "rgba(255,255,255,0.2)",
        transition: "background-color 0.5s ease"
      }} />
    ))

  const TeamSide = ({ team, isAway }: { team: any, isAway: boolean }) => {
    const teamColor = NBA_COLORS[team.tricode] || "#333"
    const isScoring = scoringTricode === team.tricode
    const bgGradient = isAway
      ? `linear-gradient(to left, ${teamColor}DD, ${teamColor}22)`
      : `linear-gradient(to right, ${teamColor}DD, ${teamColor}22)`

    return (
      <div style={{ flex: 1, display: "flex", flexDirection: isAway ? "row" : "row-reverse", background: bgGradient, alignItems: "center" }}>
        <div style={{ flex: 1, display: "flex", justifyContent: "space-evenly", alignItems: "center", padding: "0 10px", overflow: "hidden", minWidth: 0 }}>
          {team.onCourt?.map((p: any) => {
            const isScorer = scoringPlayerId === p.id
            return (
              <div key={p.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "85px", flexShrink: 1, minWidth: 0 }}>
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
                  transition: "color 0.3s ease",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  maxWidth: "85px", textAlign: "center"
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