import { Router, type Request, type Response, type NextFunction } from "express";
import { pool } from "./db";
import { requireUser, verifyToken, type TokenUser } from "./auth";

/* People: the shared cast. When a player swaps numbers with a passer-by, that person becomes a resident everyone meets
   from then on: the same face, name, home, work and evening haunt. The cast is capped; people nobody has talked to for
   30 days, and nobody is close to, move away. Relationships (phase 1: contacts) are per player. */
export const people = Router();
const userOf = (req: Request) => (req as Request & { user: TokenUser }).user;
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
const fail = (res: Response, code: number, error: string) => res.status(code).json({ error });
export const MAX_RESIDENTS = 400, MAX_PER_DAY = 25, MAX_CONTACTS = 150;
const HOME_RE = /^h:-?\d{1,5},-?\d{1,5}$/;
const spot = (o: any) => o && Number.isFinite(+o.x) && Number.isFinite(+o.z) ? { x: Math.round(+o.x * 10) / 10, z: Math.round(+o.z * 10) / 10, label: String(o.label || "").slice(0, 60) } : null;
const COLS = "id, name, female, elder, spec, persona, home, work, hang";
const optionalUser = (req: Request): TokenUser | null => { const h = req.headers.authorization || ""; const m = /^Bearer (.+)$/.exec(h); if (!m) return null; try { return verifyToken(m[1]); } catch { return null; } };

// everyone in the cast, and (signed in) who of them you know
people.get("/people", wrap(async (req, res) => {
  const cast = (await pool.query(`SELECT ${COLS} FROM residents WHERE status = 'active' ORDER BY id`)).rows;
  const me = optionalUser(req);
  const mine = me ? (await pool.query("SELECT resident_id AS id, stage, closeness, extract(epoch from since) * 1000 AS since FROM relations WHERE user_id = $1", [me.id])).rows : [];
  res.json({ cast, mine: mine.map((r) => ({ ...r, since: Math.round(+r.since) })) });
}));
// swap numbers with a passer-by: they join the cast, and your contacts. { name, female, elder, spec, persona, home, work, hang }
people.post("/people", requireUser, wrap(async (req, res) => {
  const me = userOf(req), b = req.body || {}, name = String(b.name || "").trim().slice(0, 30);
  const spec = JSON.stringify(b.spec || null), persona = JSON.stringify({ ...(b.persona || {}), name });
  if (!name || !HOME_RE.test(String(b.home || "")) || spec.length > 4000 || spec === "null" || persona.length > 2000) return fail(res, 400, "That person can't be saved");
  if ((await pool.query("SELECT count(*)::int AS n FROM residents WHERE status = 'active'")).rows[0].n >= MAX_RESIDENTS) return fail(res, 429, "The city is full: nobody new can be saved right now");
  if ((await pool.query("SELECT count(*)::int AS n FROM residents WHERE created_by = $1 AND created_at > now() - interval '24 hours'", [me.id])).rows[0].n >= MAX_PER_DAY) return fail(res, 429, "You've swapped a lot of numbers today. Try again tomorrow");
  if ((await pool.query("SELECT count(*)::int AS n FROM relations WHERE user_id = $1", [me.id])).rows[0].n >= MAX_CONTACTS) return fail(res, 429, `Your phone holds ${MAX_CONTACTS} contacts`);
  const r = (await pool.query(`INSERT INTO residents (name, female, elder, spec, persona, home, work, hang, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLS}`,
    [name, !!b.female, !!b.elder, spec, persona, b.home, JSON.stringify(spot(b.work)), JSON.stringify(spot(b.hang)), me.id])).rows[0];
  await pool.query("INSERT INTO relations (user_id, resident_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [me.id, r.id]);
  res.status(201).json({ resident: r, rel: { id: r.id, stage: "contact", closeness: 20, since: Date.now() } });
}));
// swap numbers with someone already in the cast
people.post("/people/:id/contact", requireUser, wrap(async (req, res) => {
  const me = userOf(req), id = Math.round(+req.params.id);
  if (!(await pool.query("SELECT 1 FROM residents WHERE id = $1 AND status = 'active'", [id])).rowCount) return fail(res, 404, "They've moved away");
  if ((await pool.query("SELECT count(*)::int AS n FROM relations WHERE user_id = $1", [me.id])).rows[0].n >= MAX_CONTACTS) return fail(res, 429, `Your phone holds ${MAX_CONTACTS} contacts`);
  await pool.query("INSERT INTO relations (user_id, resident_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [me.id, id]);
  await pool.query("UPDATE residents SET last_seen = now() WHERE id = $1", [id]);
  res.json({ ok: true, rel: { id, stage: "contact", closeness: 20, since: Date.now() } });
}));
// you talked to someone in the cast (keeps them around)
people.post("/people/:id/seen", wrap(async (req, res) => {
  await pool.query("UPDATE residents SET last_seen = now() WHERE id = $1 AND last_seen < now() - interval '1 hour'", [Math.round(+req.params.id)]);
  res.json({ ok: true });
}));
// delete a contact
people.delete("/people/:id/contact", requireUser, wrap(async (req, res) => {
  await pool.query("DELETE FROM relations WHERE user_id = $1 AND resident_id = $2", [userOf(req).id, Math.round(+req.params.id)]);
  res.json({ ok: true });
}));
// people nobody has seen in 30 days, and nobody knows, move away
export async function retireResidents() {
  await pool.query(`UPDATE residents r SET status = 'moved' WHERE status = 'active' AND last_seen < now() - interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM relations x WHERE x.resident_id = r.id AND x.last_contact > now() - interval '30 days')`);
}
