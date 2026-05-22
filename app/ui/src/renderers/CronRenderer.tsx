// CronRenderer — Scheduler HUD panel
// Shows all cron jobs with schedule, mode, last run, next run, and run count.

function formatRelative(ms: number | null, now: number): string {
  if (!ms) return "—";
  const diff = ms - now;
  const abs = Math.abs(diff);
  const secs = Math.floor(abs / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  let str: string;
  if (abs < 60_000) str = `${secs}s`;
  else if (abs < 3_600_000) str = `${mins}m`;
  else if (abs < 86_400_000) str = `${hours}h ${mins % 60}m`;
  else str = `${days}d`;

  return diff < 0 ? `${str} ago` : `in ${str}`;
}

function formatTime(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

interface JobData {
  id: string;
  cron: string;
  mode: string;
  role: string | null;
  model: string | null;
  target: string | null;
  recurring: boolean;
  catchUp: boolean;
  runs: number;
  createdAt: number | null;
  lastRun: number | null;
  nextRun: number | null;
  prompt: string;
}

function formatAbsolute(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function describeCron(cron: string): string {
  const s = cron.trim();
  if (s.startsWith("once:")) {
    const v = s.slice(5);
    if (v.endsWith("s")) return `One-shot in ${v.slice(0, -1)} seconds`;
    if (v.endsWith("m")) return `One-shot in ${v.slice(0, -1)} minutes`;
    if (v.endsWith("h")) return `One-shot in ${v.slice(0, -1)} hours`;
    return `One-shot in ${v}s`;
  }
  if (/^\d{1,2}:\d{2}$/.test(s)) return `Daily at ${s}`;
  const parts = s.split(" ");
  if (parts.length >= 5) {
    const [min, hour, , , dow] = parts;
    if (min.startsWith("*/")) return `Every ${min.slice(2)} minute(s)`;
    if (dow === "*") return `Daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
    if (dow === "1-5") return `Weekdays at ${hour}h${min === "0" ? "" : min}`;
    return `${dow === "1-5" ? "Weekdays" : "DOW " + dow} at ${hour}:${min.padStart(2, "0")}`;
  }
  return s;
}

export default function CronRenderer({ state }: { state: any }) {
  const { useState, useEffect } = (window as any).__JARVIS_REACT;
  const { useHudPiece } = (window as any).__JARVIS_HUD_HOOKS ?? {};

  const piece = useHudPiece?.(state.id);
  const data = piece?.data ?? state.data ?? {};

  const jobList: JobData[] = data.jobList ?? [];
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState({} as Record<string, boolean>);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  const toggle = (id: string) => setExpanded((e: Record<string, boolean>) => ({ ...e, [id]: !e[id] }));

  const s = styles;

  if (jobList.length === 0) {
    return (
      <div style={s.root}>
        <div style={s.header}>
          <span style={s.title}>⏱ SCHEDULER</span>
          <span style={s.badge}>0 jobs</span>
        </div>
        <div style={s.empty}>No scheduled jobs</div>
      </div>
    );
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <span style={s.title}>⏱ SCHEDULER</span>
        <span style={s.badge}>{jobList.length} job{jobList.length !== 1 ? "s" : ""}</span>
      </div>
      <div style={s.list}>
        {jobList.map((job) => {
          const isOpen = expanded[job.id];
          return (
            <div key={job.id} style={s.card} onClick={() => toggle(job.id)}>
              <div style={s.cardHeader}>
                <span style={s.chevron}>{isOpen ? "▼" : "▶"}</span>
                <span style={s.jobId}>{job.id}</span>
                <span style={job.recurring ? s.tagRecurring : s.tagOneShot}>
                  {job.recurring ? "recurring" : "one-shot"}
                </span>
                <span style={s.tagMode}>{job.mode}</span>
              </div>
              <div style={s.cron}>{job.cron}</div>
              {!isOpen && (
                <div style={s.prompt} title={job.prompt}>{job.prompt}</div>
              )}
              <div style={s.meta}>
                <span style={s.metaItem}>
                  <span style={s.metaLabel}>last</span>
                  <span style={s.metaValue}>{job.lastRun ? formatTime(job.lastRun) : "never"}</span>
                </span>
                <span style={s.metaItem}>
                  <span style={s.metaLabel}>next</span>
                  <span style={{ ...s.metaValue, color: "#4fc3f7" }}>{formatRelative(job.nextRun, now)}</span>
                </span>
                <span style={s.metaItem}>
                  <span style={s.metaLabel}>runs</span>
                  <span style={s.metaValue}>{job.runs}</span>
                </span>
              </div>
              {isOpen && (
                <div style={s.expand}>
                  <div style={s.row}>
                    <span style={s.rowLabel}>schedule</span>
                    <span style={s.rowValue}>{describeCron(job.cron)}</span>
                  </div>
                  <div style={s.row}>
                    <span style={s.rowLabel}>mode</span>
                    <span style={s.rowValue}>{job.mode}</span>
                  </div>
                  {job.role && (
                    <div style={s.row}>
                      <span style={s.rowLabel}>role</span>
                      <span style={s.rowValue}>{job.role}</span>
                    </div>
                  )}
                  {job.model && (
                    <div style={s.row}>
                      <span style={s.rowLabel}>model</span>
                      <span style={s.rowValue}>{job.model}</span>
                    </div>
                  )}
                  {job.target && (
                    <div style={s.row}>
                      <span style={s.rowLabel}>target</span>
                      <span style={s.rowValue}>{job.target}</span>
                    </div>
                  )}
                  <div style={s.row}>
                    <span style={s.rowLabel}>catch-up</span>
                    <span style={{ ...s.rowValue, color: job.catchUp ? "#66bb6a" : "#555" }}>
                      {job.catchUp ? "yes" : "no"}
                    </span>
                  </div>
                  <div style={s.row}>
                    <span style={s.rowLabel}>created</span>
                    <span style={s.rowValue}>{formatAbsolute(job.createdAt)}</span>
                  </div>
                  <div style={s.row}>
                    <span style={s.rowLabel}>last run</span>
                    <span style={s.rowValue}>{formatAbsolute(job.lastRun)}</span>
                  </div>
                  <div style={s.row}>
                    <span style={s.rowLabel}>next run</span>
                    <span style={{ ...s.rowValue, color: "#4fc3f7" }}>{formatAbsolute(job.nextRun)}</span>
                  </div>
                  <div style={s.rowFull}>
                    <span style={s.rowLabel}>prompt</span>
                    <pre style={s.promptFull} onClick={(e: any) => e.stopPropagation()}>{job.prompt}</pre>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, any> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "12px",
    color: "#e0e0e0",
    padding: "10px",
    boxSizing: "border-box",
    gap: "8px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  title: {
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.08em",
    color: "#aaa",
    textTransform: "uppercase",
  },
  badge: {
    fontSize: "10px",
    backgroundColor: "#2a2a2a",
    color: "#888",
    borderRadius: "8px",
    padding: "1px 6px",
    border: "1px solid #333",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    overflowY: "auto",
    flex: 1,
  },
  card: {
    backgroundColor: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: "6px",
    padding: "8px 10px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    cursor: "pointer",
    userSelect: "none",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  chevron: {
    fontSize: "9px",
    color: "#666",
    width: "10px",
  },
  expand: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginTop: "6px",
    paddingTop: "6px",
    borderTop: "1px solid #2a2a2a",
  },
  row: {
    display: "flex",
    gap: "8px",
    alignItems: "baseline",
  },
  rowFull: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    marginTop: "2px",
  },
  rowLabel: {
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#555",
    minWidth: "60px",
  },
  rowValue: {
    fontSize: "11px",
    color: "#aaa",
    fontFamily: "monospace",
  },
  promptFull: {
    margin: 0,
    fontSize: "10px",
    color: "#888",
    backgroundColor: "#0d0d0d",
    border: "1px solid #2a2a2a",
    borderRadius: "4px",
    padding: "6px 8px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: "monospace",
    maxHeight: "120px",
    overflowY: "auto",
  },
  jobId: {
    fontWeight: 600,
    fontSize: "12px",
    color: "#e0e0e0",
    flex: 1,
  },
  tagRecurring: {
    fontSize: "9px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    backgroundColor: "#1b3a1b",
    color: "#66bb6a",
    borderRadius: "4px",
    padding: "1px 5px",
    border: "1px solid #2d5a2d",
  },
  tagOneShot: {
    fontSize: "9px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    backgroundColor: "#2a2a1a",
    color: "#ffd54f",
    borderRadius: "4px",
    padding: "1px 5px",
    border: "1px solid #4a4a1a",
  },
  tagMode: {
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#666",
    backgroundColor: "#222",
    borderRadius: "4px",
    padding: "1px 5px",
    border: "1px solid #2a2a2a",
  },
  cron: {
    fontSize: "11px",
    fontFamily: "monospace",
    color: "#81d4fa",
  },
  prompt: {
    fontSize: "10px",
    color: "#666",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  meta: {
    display: "flex",
    gap: "12px",
    marginTop: "2px",
  },
  metaItem: {
    display: "flex",
    gap: "4px",
    alignItems: "center",
  },
  metaLabel: {
    fontSize: "9px",
    textTransform: "uppercase",
    color: "#555",
    letterSpacing: "0.05em",
  },
  metaValue: {
    fontSize: "11px",
    color: "#aaa",
  },
  empty: {
    color: "#555",
    fontStyle: "italic",
    fontSize: "11px",
    textAlign: "center",
    paddingTop: "20px",
  },
};
