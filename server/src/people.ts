import { Router, type Request, type Response, type NextFunction } from "express";
import { pool } from "./db";
import { requireUser, verifyToken, type TokenUser } from "./auth";
import { wallet, stateOf } from "./land";

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

/* closeness: 0 to 100 per person. Talk moves it a little (up to 12 a day): asking about what they're into lands when you
   remember right, a joke depends on their mood, compliments wear thin. Gifts move it more, double when it suits them,
   and more on their birthday (two a day). Three quiet days in, it fades a point a day. Friends at 40, close at 70. */
export const GIFTS: Record<string, [string, number, number, string[]]> = {   // [name, price, closeness, interests it suits]
  suya: ["Suya wrap", 2000, 3, ["cooking", "football"]], chocolate: ["Chocolates", 3000, 4, []], jollof: ["Party jollof, a pack", 4000, 4, ["jollof debates", "cooking", "owambe parties"]],
  flowers: ["Flowers", 5000, 5, []], book: ["A novel", 6000, 5, ["books", "politics"]], cinema: ["Cinema tickets", 8000, 6, ["Nollywood"]], jersey: ["Super Eagles jersey", 15000, 7, ["football", "fitness"]],
  bag: ["Travel bag", 18000, 7, ["travel"]], ankara: ["Ankara fabric", 20000, 8, ["fashion", "owambe parties", "church"]], tickets: ["Concert tickets", 25000, 9, ["Afrobeats", "dancing"]],
  perfume: ["Perfume", 30000, 9, ["fashion"]], watch: ["Wristwatch", 60000, 11, ["business", "cars", "fashion"]], phone: ["A new phone", 150000, 14, ["tech"]],
};
const TALK_CAP = 12, GIFTS_A_DAY = 2;
const STAGES = ["contact", "friend", "close"];
const decayed = (c: number, last: Date) => Math.max(0, c - Math.max(0, Math.floor((Date.now() - +new Date(last)) / 86400e3) - 3));
function stageOf(c: number, prev: string) {
  if (c >= 70 || (prev === "close" && c >= 60)) return "close";
  if (c >= 40 || ((prev === "friend" || prev === "close") && c >= 30)) return "friend";
  return "contact";
}
const lagosDay = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
const dayOfYear = () => { const d = new Date(Date.now() + 3600e3); return Math.floor((+d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400e3); };
const relOut = (r: any) => ({ id: r.resident_id ?? r.id, stage: r.stage, closeness: r.closeness, since: Math.round(+new Date(r.since)), last: Math.round(+new Date(r.last_contact)) });
// move closeness by d (talk: counted against the day's cap; gift: counted against the day's gifts)
async function bump(c: any, me: string, id: number, d: number, kind: "talk" | "gift" | "compliment") {
  const r = (await c.query("SELECT *, day::text AS day_s FROM relations WHERE user_id = $1 AND resident_id = $2 FOR UPDATE", [me, id])).rows[0];
  if (!r) return null;
  const today = lagosDay(), fresh = r.day_s !== today;   // (as text: a date column comes back shifted by the server's timezone)
  let gain = fresh ? 0 : r.day_gain, gifts = fresh ? 0 : r.gifts, comps = fresh ? 0 : r.compliments;
  if (kind === "gift") { if (gifts >= GIFTS_A_DAY) return { refused: true }; gifts++; }
  else { if (d > 0) { d = Math.max(0, Math.min(d, TALK_CAP - gain)); gain += d; } if (kind === "compliment") comps++; }
  const before = decayed(r.closeness, r.last_contact), now = Math.max(0, Math.min(100, before + d)), stage = stageOf(now, r.stage);
  const u = (await c.query("UPDATE relations SET closeness = $3, stage = $4, last_contact = now(), day = $5, day_gain = $6, gifts = $7, compliments = $8 WHERE user_id = $1 AND resident_id = $2 RETURNING *",
    [me, id, now, stage, today, gain, gifts, comps])).rows[0];
  await c.query("UPDATE residents SET last_seen = now() WHERE id = $1", [id]);
  return { rel: relOut(u), delta: now - before, up: STAGES.indexOf(stage) > STAGES.indexOf(r.stage), down: STAGES.indexOf(stage) < STAGES.indexOf(r.stage), compliments: comps };
}
// everyone in the cast, and (signed in) who of them you know
people.get("/people", wrap(async (req, res) => {
  const cast = (await pool.query(`SELECT ${COLS} FROM residents WHERE status = 'active' ORDER BY id`)).rows;
  const me = optionalUser(req);
  const mine = me ? (await pool.query("SELECT * FROM relations WHERE user_id = $1", [me.id])).rows : [];
  res.json({ cast, mine: mine.map((r) => { const c = decayed(r.closeness, r.last_contact); return { ...relOut(r), closeness: c, stage: stageOf(c, r.stage) }; }), gifts: GIFTS });
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
// a conversation with someone you know: { topic, about } (about: the interest you asked about)
people.post("/people/:id/talk", requireUser, wrap(async (req, res) => {
  const me = userOf(req), id = Math.round(+req.params.id), topic = String(req.body?.topic || ""), about = String(req.body?.about || "");
  const P = (await pool.query("SELECT persona FROM residents WHERE id = $1", [id])).rows[0]?.persona; if (!P) return fail(res, 404, "They've moved away");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const prev = (await c.query("SELECT compliments, day::text AS day_s FROM relations WHERE user_id = $1 AND resident_id = $2", [me.id, id])).rows[0];
    if (!prev) { await c.query("ROLLBACK"); return fail(res, 404, "Swap numbers first"); }
    const compsToday = prev.day_s === lagosDay() ? prev.compliments : 0;
    let d = 1, kind: "talk" | "compliment" = "talk", hit: boolean | null = null;
    if (topic === "interest") { hit = (P.interests || []).includes(about); d = hit ? 5 : 0; }
    else if (topic === "joke") d = P.mood === "grumpy" ? -2 : P.mood === "shy" ? 1 : 3;
    else if (topic === "compliment") { kind = "compliment"; d = compsToday === 0 ? 3 : compsToday === 1 ? 0 : -1; }
    else if (topic === "day") d = 2;
    const out = await bump(c, me.id, id, d, kind);
    await c.query("COMMIT");
    res.json({ ok: true, hit, ...out });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}));
// a gift, bought and given on the spot: { gift, base }
people.post("/people/:id/gift", requireUser, wrap(async (req, res) => {
  const me = userOf(req), id = Math.round(+req.params.id), G = GIFTS[String(req.body?.gift || "")];
  if (!G) return fail(res, 400, "There's no such gift");
  const P = (await pool.query("SELECT persona FROM residents WHERE id = $1 AND status = 'active'", [id])).rows[0]?.persona; if (!P) return fail(res, 404, "They've moved away");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const w = await wallet(c, me.id, true);
    if (w.synced_at && req.body?.base !== w.version) { await c.query("ROLLBACK"); return res.status(409).json({ error: "Your money changed: syncing first", stale: true, state: await stateOf(pool, me.id) }); }
    if (w.money < G[1]) { await c.query("ROLLBACK"); return fail(res, 402, `${G[0]} is ₦${G[1].toLocaleString("en-NG")}; you don't have enough`); }
    const suits = G[3].some((x) => (P.interests || []).includes(x)), birthday = P.birthday === dayOfYear();
    const out = await bump(c, me.id, id, Math.round(G[2] * (suits ? 2 : 1) * (birthday ? 1.5 : 1)), "gift");
    if (!out) { await c.query("ROLLBACK"); return fail(res, 404, "Swap numbers first"); }
    if ((out as any).refused) { await c.query("ROLLBACK"); return fail(res, 429, "They won't take another gift today"); }
    const u = (await c.query("UPDATE wallets SET money = money - $2, version = version + 1, updated_at = now() WHERE user_id = $1 RETURNING version, money::float8 AS money", [me.id, G[1]])).rows[0];
    await c.query("COMMIT");
    res.json({ ok: true, suits, birthday, ...out, version: u.version, money: Math.round(u.money) });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}));

