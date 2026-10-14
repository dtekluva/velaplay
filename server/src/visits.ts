import { Router, type Request } from "express";
import { pool } from "./db";
import { requireUser, type TokenUser } from "./auth";

/* The visit log: every time someone joins the world (guest or account) we keep a row with when, how long, phone or
   desktop, how far they went and which parts of the map they visited. Rows are refreshed every minute while they play,
   so a restart loses at most a minute. The stats (GET /api/stats) are for admins only (ADMIN_IDS in .env). */
export interface Visit { id: number | null; ready: Promise<void>; x: number; z: number; metres: number; areas: Set<string> }
export const live = new Map<string, { name: string; guest: boolean; device: string; since: number; area: string }>();

// roughly where a spot is (the game's map: north is negative z)
export function areaOf(x: number, z: number): string {
  if (z < -5560) return "Oyo town";
  if (z < -4724) return "Ibadan";
  if (z < -1160) return "Lagos–Ibadan Expressway";
  if (z < -740) return "Ikeja";
  if (z < -360) return "Yaba & UNILAG";
  if (z > 330) return "Lekki port & the sea";
  if (z > 230) return "Elegushi Beach";
  if (x < -36 && x > -200 && z < -34 && z > -200) return "Naija City";
  if (x > 20 && z < -40) return "The airport";
  if (z > 120) return "Coast road & Meadowbrook";
  return "Forest & villages";
}

export function startVisit(sessionId: string, userId: string | null, name: string, device: string, x: number, z: number): Visit {
  const v: Visit = { id: null, ready: Promise.resolve(), x, z, metres: 0, areas: new Set([areaOf(x, z)]) };
  v.ready = pool.query("INSERT INTO sessions (user_id, name, guest, device, areas) VALUES ($1, $2, $3, $4, $5) RETURNING id", [userId, name, !userId, device, [...v.areas]])
    .then((r) => { v.id = r.rows[0].id; }).catch((e) => console.error("visit log:", e.message));
  live.set(sessionId, { name, guest: !userId, device, since: Date.now(), area: areaOf(x, z) });
  return v;
}
// a position sample (every few seconds): distance and the area
export function sampleVisit(sessionId: string, v: Visit, x: number, z: number) {
  const d = Math.hypot(x - v.x, z - v.z); if (d < 400) v.metres += d;   // skip teleports (flights, respawns) for the distance
  v.x = x; v.z = z; const a = areaOf(x, z); v.areas.add(a);
  const l = live.get(sessionId); if (l) l.area = a;
}
export async function saveVisit(v: Visit, ended = false) {
  await v.ready; if (v.id == null) return;
  await pool.query("UPDATE sessions SET last_seen = now(), metres = $2, areas = $3, ended = ended OR $4 WHERE id = $1", [v.id, Math.round(v.metres), [...v.areas], ended]).catch((e) => console.error("visit log:", e.message));
}

export const visits = Router();
const userOf = (req: Request) => (req as Request & { user: TokenUser }).user;
const admins = () => new Set((process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
visits.get("/stats", requireUser, async (req, res) => { try {   // errors stay in here: an async throw would otherwise take the whole server down
  if (!admins().has(userOf(req).id)) return res.status(403).json({ error: "Only admins can see the stats" });
  const q = (sql: string, args: unknown[] = []) => pool.query(sql, args).then((r) => r.rows);
  const dur = "EXTRACT(EPOCH FROM last_seen - started_at)";
  const [totals] = await q(`SELECT count(*)::int AS visits,
      count(DISTINCT COALESCE(user_id::text, 'guest:' || lower(name)))::int AS players,
      count(*) FILTER (WHERE guest)::int AS guest_visits,
      count(*) FILTER (WHERE device = 'phone')::int AS phone_visits,
      COALESCE(round(sum(${dur}) / 3600, 1), 0)::float AS hours,
      COALESCE(round(avg(${dur}) / 60, 1), 0)::float AS avg_minutes,
      COALESCE(sum(metres), 0)::bigint AS metres,
      min(started_at) AS since FROM sessions`);
  const days = await q(`SELECT to_char(started_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS day, count(*)::int AS visits,
      count(DISTINCT COALESCE(user_id::text, 'guest:' || lower(name)))::int AS players, round(sum(${dur}) / 60)::int AS minutes
      FROM sessions WHERE started_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`);
  const areas = await q(`SELECT a AS area, count(*)::int AS visits FROM sessions, unnest(areas) a GROUP BY a ORDER BY 2 DESC`);
  const players = await q(`SELECT name, guest, count(*)::int AS visits, round(sum(${dur}) / 60)::int AS minutes, max(last_seen) AS last_seen,
      bool_or(device = 'phone') AS phone FROM sessions GROUP BY COALESCE(user_id::text, 'guest:' || lower(name)), name, guest ORDER BY max(last_seen) DESC LIMIT 100`);
  const recent = await q(`SELECT name, guest, device, started_at, round(${dur} / 60, 1)::float AS minutes, metres, areas, ended FROM sessions ORDER BY started_at DESC LIMIT 60`);
  const accounts = await q(`SELECT count(*)::int AS accounts, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_this_week FROM users`);
  res.json({ totals, accounts: accounts[0], days, areas, players, recent, live: [...live.values()].map((l) => ({ ...l, minutes: Math.round((Date.now() - l.since) / 60000) })) });
} catch (e: any) { console.error("stats:", e.message); res.status(500).json({ error: "Could not load the stats" }); } });
