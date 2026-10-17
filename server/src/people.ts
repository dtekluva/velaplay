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
const COLS = "id, name, female, elder, spec, persona, home, work, hang, partner_user IS NOT NULL AS taken";
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
const relOut = (r: any) => ({ id: r.resident_id ?? r.id, stage: r.stage, closeness: r.closeness, since: Math.round(+new Date(r.since)), last: Math.round(+new Date(r.last_contact)),
  romance: r.romance || null, spark: r.romance || r.spark ? decayed(r.spark || 0, r.last_contact) : 0, rsince: r.romance_since ? Math.round(+new Date(r.romance_since)) : null });
// move closeness by d (talk: counted against the day's cap; gift: counted against the day's gifts)
async function bump(c: any, me: string, id: number, d: number, kind: "talk" | "gift" | "compliment" | "hangout" | "favour" | "loss") {
  const r = (await c.query("SELECT *, day::text AS day_s FROM relations WHERE user_id = $1 AND resident_id = $2 FOR UPDATE", [me, id])).rows[0];
  if (!r) return null;
  const today = lagosDay(), fresh = r.day_s !== today;   // (as text: a date column comes back shifted by the server's timezone)
  let gain = fresh ? 0 : r.day_gain, gifts = fresh ? 0 : r.gifts, comps = fresh ? 0 : r.compliments, hang = fresh ? 0 : r.hangouts, fav = fresh ? 0 : r.favours;
  if (kind === "gift") { if (gifts >= GIFTS_A_DAY) return { refused: true }; gifts++; }
  else if (kind === "hangout") { if (hang >= 1) d = 2; hang++; }   // the first time out together a day counts most
  else if (kind === "favour") { if (fav >= 1) d = 1; fav++; }
  else if (kind === "loss") d = Math.min(0, d);   // an ignored text: never more than a nudge down
  else { if (d > 0) { d = Math.max(0, Math.min(d, TALK_CAP - gain)); gain += d; } if (kind === "compliment") comps++; }
  const before = decayed(r.closeness, r.last_contact), now = Math.max(0, Math.min(100, before + d)), stage = stageOf(now, r.stage);
  const spk = r.romance && (kind === "hangout" || kind === "gift") ? Math.min(100, decayed(r.spark || 0, r.last_contact) + (kind === "hangout" ? 5 : 3)) : r.spark;   // dates and gifts feed the spark
  const u = (await c.query(`UPDATE relations SET spark = ${Number(spk) | 0}, closeness = $3, stage = $4, last_contact = ${kind === "loss" ? "last_contact" : "now()"}, day = $5, day_gain = $6, gifts = $7, compliments = $8, hangouts = $9, favours = $10 WHERE user_id = $1 AND resident_id = $2 RETURNING *`,
    [me, id, now, stage, today, gain, gifts, comps, hang, fav])).rows[0];
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
    let d = 1, kind: "talk" | "compliment" | "hangout" | "favour" | "loss" = "talk", hit: boolean | null = null;
    if (topic === "interest") { hit = (P.interests || []).includes(about); d = hit ? 5 : 0; }
    else if (topic === "joke") d = P.mood === "grumpy" ? -2 : P.mood === "shy" ? 1 : 3;
    else if (topic === "compliment") { kind = "compliment"; d = compsToday === 0 ? 3 : compsToday === 1 ? 0 : -1; }
    else if (topic === "day") d = 2;
    else if (topic === "text_warm" || topic === "call") d = 2;            // a kind reply, a phone call
    else if (topic === "text_fun") d = P.mood === "grumpy" ? 0 : 2;
    else if (topic === "text_cold") d = -1;
    else if (topic === "ignored") { kind = "loss"; d = -1; }               // a text left unanswered
    else if (topic === "hangout") { kind = "hangout"; d = 8; }             // time out together
    else if (topic === "favour") { kind = "favour"; d = 5; }               // you did what they asked
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

/* romance: flirting (three times a day, +7) grows the spark, if they're into you; then you ask: out (dating), to go steady
   (partner), to marry (engaged: with a ring) and the wedding itself. A resident is with one player at a time. */
const ROMANCE = ["dating", "partner", "engaged", "married"], RING = 500_000, WEDDING = 1_500_000;
const attracted = (P: any, female: boolean) => P && !P.elder && (P.likes === "both" || (P.likes === "men" && !female) || (P.likes === "women" && female));
people.post("/people/:id/romance", requireUser, wrap(async (req, res) => {
  const me = userOf(req), id = Math.round(+req.params.id), act = String(req.body?.act || ""), female = !!req.body?.female;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const R = (await c.query("SELECT id, name, elder, persona, partner_user FROM residents WHERE id = $1 AND status = 'active' FOR UPDATE", [id])).rows[0];
    const r = (await c.query("SELECT *, day::text AS day_s FROM relations WHERE user_id = $1 AND resident_id = $2 FOR UPDATE", [me.id, id])).rows[0];
    if (!R || !r) { await c.query("ROLLBACK"); return fail(res, 404, "Swap numbers first"); }
    const P = { ...R.persona, elder: R.elder }, close = decayed(r.closeness, r.last_contact), spark = decayed(r.spark || 0, r.last_contact), today = lagosDay(), fresh = r.day_s !== today;
    const hours = r.romance_since ? (Date.now() - +new Date(r.romance_since)) / 3600e3 : 0, taken = R.partner_user && R.partner_user !== me.id;
    const done = async (sets: string, vals: any[], extra: object = {}) => {
      const u = (await c.query(`UPDATE relations SET ${sets}, last_contact = now() WHERE user_id = $1 AND resident_id = $2 RETURNING *`, [me.id, id, ...vals])).rows[0];
      await c.query("COMMIT"); res.json({ ok: true, rel: relOut(u), ...extra });
    };
    const no = async (why: string, cost = 0) => { if (cost) await c.query("UPDATE relations SET closeness = GREATEST(0, closeness - $3) WHERE user_id = $1 AND resident_id = $2", [me.id, id, cost]); await c.query("COMMIT"); res.json({ ok: false, why, cost }); };
    if (act === "flirt") {
      if (!attracted(P, female)) return no("not_into_you", r.flirts > 0 && !fresh ? 1 : 0);
      if (taken) return no("taken");
      if (close < 40) return no("too_soon");
      const n = fresh ? 0 : r.flirts; if (n >= 3) return no("too_much", 2);
      return done("spark = $3, flirts = $4, day = $5", [Math.min(100, spark + 7), n + 1, today], { spark: Math.min(100, spark + 7) });
    }
    if (act === "ask_out") {
      if (r.romance) return no("already");
      if (!attracted(P, female)) return no("not_into_you", 3);
      if (taken) return no("taken");
      if (close < 45 || spark < 20) return no("not_yet", 3);
      await c.query("UPDATE residents SET partner_user = $2 WHERE id = $1", [id, me.id]);
      return done("romance = 'dating', romance_since = now()", []);
    }
    const step = ROMANCE.indexOf(r.romance);
    if (act === "commit") {
      if (r.romance !== "dating") return no("not_dating");
      if (close < 65 || spark < 50 || hours < 6) return no("not_yet", 2);
      return done("romance = 'partner', romance_since = now()", []);
    }
    if (act === "propose" || act === "marry") {
      const cost = act === "propose" ? RING : WEDDING, need = act === "propose" ? "partner" : "engaged";
      if (r.romance !== need) return no(act === "propose" ? "not_partner" : "not_engaged");
      if (act === "propose" && (close < 80 || spark < 70 || hours < 12)) return no("not_yet", 3);
      const w = await wallet(c, me.id, true);
      if (w.synced_at && req.body?.base !== w.version) { await c.query("ROLLBACK"); return res.status(409).json({ error: "Your money changed: syncing first", stale: true, state: await stateOf(pool, me.id) }); }
      if (w.money < cost) return no("money");
      const u = (await c.query("UPDATE wallets SET money = money - $2, version = version + 1, updated_at = now() WHERE user_id = $1 RETURNING version, money::float8 AS money", [me.id, cost])).rows[0];
      return done(`romance = '${act === "propose" ? "engaged" : "married"}', romance_since = now(), closeness = LEAST(100, closeness + 5)`, [], { cost, version: u.version, money: Math.round(u.money) });
    }
    if (act === "move_in") {
      const home = String(req.body?.home || "");
      if (step < 1) return no("not_partner");
      if (!HOME_RE.test(home)) return fail(res, 400, "That isn't a home");
      await c.query("UPDATE residents SET home = $2 WHERE id = $1", [id, home]);
      return done("closeness = LEAST(100, closeness + 3)", [], { home });
    }
    if (act === "break_up") {
      if (!r.romance) return no("not_together");
      await c.query("UPDATE residents SET partner_user = NULL WHERE id = $1 AND partner_user = $2", [id, me.id]);
      return done("romance = NULL, romance_since = NULL, spark = 0, closeness = GREATEST(0, closeness - 25), stage = CASE WHEN closeness - 25 >= 40 THEN 'friend' ELSE 'contact' END", []);
    }
    await c.query("ROLLBACK"); return fail(res, 400, "Unknown");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}));

