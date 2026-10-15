import { Router, type Request, type Response, type NextFunction } from "express";
import { pool } from "./db";
import { requireUser, type TokenUser } from "./auth";

/* Daily goals and reputation. Every day (Lagos time) the game sets three goals, one easy, one medium, one hard, the
   same for everyone. Finishing one earns reputation (and money, in the game); all three in a day earns a bonus and
   keeps your streak going. Reputation gives you a title that everyone online sees over your head. The server holds
   accounts' reputation: it takes at most three claims a day, each goal once, and prices them itself. */
export const progress = Router();
const userOf = (req: Request) => (req as Request & { user: TokenUser }).user;
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export const TIER_REP = { easy: 10, medium: 20, hard: 35 } as const, ALL_BONUS = 25;
// the goals the game can set (visit goals are "visit:<place>", all medium); the game holds what each asks
const GOALS: Record<string, keyof typeof TIER_REP> = {
  help1: "easy", talk3: "easy", museum3: "easy", eat1: "easy", dance1: "easy", drive2k: "easy", walk1k: "easy",
  parcel2: "medium", fare2: "medium", train1: "medium", museum8: "medium", drive10k: "medium", help3: "medium",
  thief1: "hard", fly1: "hard", parcel5: "hard", fare5: "hard", train3: "hard", boat1: "hard", museums4: "hard",
};
export const tierOf = (id: string) => GOALS[id] ?? (/^visit:[a-z0-9-]{2,40}$/.test(id) ? "medium" : null);
export const TITLES: [number, string][] = [[0, "JJC"], [60, "Street Smart"], [180, "Hustler"], [400, "Big Boss"], [800, "Odogwu"], [1500, "Chief"], [3000, "Oga at the Top"], [6000, "Living Legend"]];
export const titleOf = (rep: number) => { let t = TITLES[0][1]; for (const [n, name] of TITLES) if (rep >= n) t = name; return t; };
export const GUEST_REP_MAX = 400;   // a guest's reputation lives on their device; the most we'll show for it
export const lagosDay = (ms = Date.now()) => new Date(ms + 3600_000).toISOString().slice(0, 10);

// rooms listen so a new title shows straight away
const titleFns = new Set<(userId: string, title: string) => void>();
export const onTitle = (fn: (userId: string, title: string) => void) => { titleFns.add(fn); return () => titleFns.delete(fn); };

export async function progressOf(id: string) {
  await pool.query("INSERT INTO progress (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
  const r = (await pool.query("SELECT rep, streak, full_day::text AS full_day, day::text AS day, claimed FROM progress WHERE user_id = $1", [id])).rows[0];
  const today = lagosDay(), yesterday = lagosDay(Date.now() - 86400_000);
  const streak = r.full_day === today || r.full_day === yesterday ? r.streak : 0;   // a missed day ends the streak
  return { rep: r.rep, streak, title: titleOf(r.rep), day: today, claimed: r.day === today ? r.claimed : [] };
}

progress.get("/progress", requireUser, wrap(async (req, res) => { res.json(await progressOf(userOf(req).id)); }));

// a goal done: { goal, day }. Today's only, each goal once, three a day.
progress.post("/progress/claim", requireUser, wrap(async (req, res) => {
  const me = userOf(req), goal = String(req.body?.goal || ""), tier = tierOf(goal), today = lagosDay();
  if (!tier) return res.status(400).json({ error: "That isn't a goal" });
  if (req.body?.day !== today) return res.status(409).json({ error: "That was yesterday's goal", ...(await progressOf(me.id)) });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("INSERT INTO progress (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [me.id]);
    const r = (await c.query("SELECT rep, streak, full_day::text AS full_day, day::text AS day, claimed FROM progress WHERE user_id = $1 FOR UPDATE", [me.id])).rows[0];
    const claimed: string[] = r.day === today ? r.claimed : [];
    if (claimed.includes(goal)) { await c.query("ROLLBACK"); return res.status(409).json({ error: "Already done", ...(await progressOf(me.id)) }); }
    if (claimed.length >= 3) { await c.query("ROLLBACK"); return res.status(429).json({ error: "Three goals a day", ...(await progressOf(me.id)) }); }
    const now = [...claimed, goal], tiers = new Set(now.map(tierOf));
    let rep = r.rep + TIER_REP[tier], streak = r.streak, fullDay = r.full_day, bonus = 0;
    if (now.length === 3 && tiers.size === 3) {   // all three of today's (one of each tier): the bonus, and the streak
      const yesterday = lagosDay(Date.now() - 86400_000);
      streak = fullDay === yesterday ? streak + 1 : 1; fullDay = today; bonus = ALL_BONUS; rep += bonus;
    }
    await c.query("UPDATE progress SET rep = $2, streak = $3, full_day = $4, day = $5, claimed = $6, updated_at = now() WHERE user_id = $1", [me.id, rep, streak, fullDay, today, now]);
    await c.query("COMMIT");
    const title = titleOf(rep); for (const fn of titleFns) fn(me.id, title);
    res.json({ ok: true, gained: TIER_REP[tier] + bonus, bonus: bonus > 0, rep, streak, title, day: today, claimed: now });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}));
