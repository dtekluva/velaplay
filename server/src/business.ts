import { Router, type Request, type Response, type NextFunction } from "express";
import { pool } from "./db";
import { requireUser, type TokenUser } from "./auth";
import { wallet, stateOf } from "./land";

/* Businesses: buy a shop, a buka, a kiosk or a filling station; it earns while you play and while you're away. The till
   fills by the hour (a rate for the kind of business, times its level, its prices and its name on the street) up to a
   cap: 8 hours, or 24 with a manager. Collecting moves the till into your wallet, now and then with a surprise (the light
   goes, a big order comes in). Upgrades, a manager and prices are yours to set; selling gets back 70% of what you put in.
   The client has the same table (BIZ_TYPES) to show prices; the server's is the one that counts. */
export const business = Router();
const userOf = (req: Request) => (req as Request & { user: TokenUser }).user;
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
const fail = (res: Response, code: number, error: string, extra: object = {}) => res.status(code).json({ error, ...extra });
const naira = (n: number) => "₦" + Math.round(n).toLocaleString("en-NG");

// [name, price, ₦ an hour at level 1]
export const BIZ_TYPES: Record<string, [string, number, number]> = {
  buka: ["Buka", 2_500_000, 42_000], suya: ["Suya spot", 1_500_000, 26_000], kiosk: ["Provision kiosk", 900_000, 15_500], drinks: ["Cold drinks stand", 700_000, 12_000],
  pos: ["POS & mobile money", 600_000, 10_500], phones: ["Phones & gadgets", 3_000_000, 50_000], pharmacy: ["Pharmacy", 6_000_000, 96_000], barber: ["Barbing salon", 1_200_000, 21_000],
  salon: ["Hair & beauty salon", 1_800_000, 31_000], tailor: ["Tailor's shop", 1_000_000, 17_500], print: ["Printing press", 1_400_000, 24_000], pastry: ["Pastry shop", 2_000_000, 34_000],
  cafe: ["Cyber café", 2_000_000, 33_000], parts: ["Spare-parts dealer", 5_000_000, 80_000], textiles: ["Textile shop", 3_500_000, 58_000], minimart: ["Minimart", 4_000_000, 66_000],
  bakery: ["Bakery", 7_000_000, 112_000], boutique: ["Boutique", 6_500_000, 104_000], electronics: ["Electronics store", 9_000_000, 142_000], restaurant: ["Restaurant", 8_000_000, 128_000],
  supermarket: ["Supermarket", 14_000_000, 215_000], fuel: ["Filling station", 25_000_000, 380_000],
};
export const LEVEL_MULT = [0, 1, 1.5, 2.1, 2.9, 4], UPGRADE_COST = [0, 0, .5, .8, 1.2, 2];   // the price of reaching each level, as a share of the business's price
export const MODE_K: Record<string, number> = { low: .9, fair: 1, high: 1.12 }, MAX_BIZ = 8, CAP_H = 8, CAP_MANAGER_H = 24, MANAGER_SHARE = .2, SELL_BACK = .7;
const KEY_RE = /^[yiv]:-?\d{1,5},-?\d{1,5}$/;

type Row = { key: string; type: string; label: string; level: number; mode: string; manager: boolean; rep: number; invested: number; earned: number; last_collect: Date; bought_at: Date };
const rate = (b: Row) => BIZ_TYPES[b.type][2] * LEVEL_MULT[b.level] * (MODE_K[b.mode] ?? 1) * (1 + b.rep / 400);
const hours = (b: Row, now = Date.now()) => Math.min(b.manager ? CAP_MANAGER_H : CAP_H, Math.max(0, (now - +new Date(b.last_collect)) / 3600e3));
const till = (b: Row, now = Date.now()) => Math.floor(rate(b) * hours(b, now));
const view = (b: Row) => ({ key: b.key, type: b.type, label: b.label, level: b.level, mode: b.mode, manager: b.manager, rep: b.rep, invested: Math.round(+b.invested), earned: Math.round(+b.earned),
  rate: Math.round(rate(b)), till: till(b), hours: +hours(b).toFixed(2), cap: b.manager ? CAP_MANAGER_H : CAP_H, since: +new Date(b.last_collect) });
const stale = async (res: Response, id: string) => fail(res, 409, "Your money changed: syncing first", { stale: true, state: await stateOf(pool, id) });
const moneyOut = (w: { version: number; money: number }) => ({ version: w.version, money: Math.round(w.money) });
const SEL = "key, type, label, level, mode, manager, rep, invested::float8 AS invested, earned::float8 AS earned, last_collect, bought_at";

// a surprise at collection time, now and then (the street is never quiet)
function surprise(b: Row, t: number): { text: string; delta: number } | null {
  if (t <= 0 || Math.random() > .2) return null;
  const food = ["buka", "suya", "restaurant", "bakery", "pastry", "minimart", "supermarket"].includes(b.type);
  const pool_: [string, number][] = [["NEPA took light: diesel for the generator", -.1], ["Council officials came for “levy”", -.06], ["Area boys wanted something for the weekend", -.05],
    ["A big order came in from an office on the street", .25], ["Word got round: a queue at the door all afternoon", .15], ["A customer paid off an old debt", .08]];
  if (food) pool_.push(["The owambe next door ordered catering", .4], ["Market day: everyone was hungry", .2]);
  if (b.type === "fuel") pool_.push(["Fuel scarcity: queues round the block", .45], ["The tanker came late", -.12]);
  if (b.mode === "high") pool_.push(["Customers grumbled about your prices", -.08]);
  if (b.mode === "low") pool_.push(["Your low prices brought new faces", .12]);
  const [text, k] = pool_[Math.floor(Math.random() * pool_.length)];
  return { text, delta: Math.round(t * k) };
}

// everyone's businesses: who owns which (for the signs), no money figures
business.get("/biz", wrap(async (_req, res) => {
  const q = await pool.query("SELECT b.key, b.type, b.level, u.display_name AS owner FROM businesses b JOIN users u ON u.id = b.owner");
  res.json({ owned: q.rows });
}));
business.get("/biz/mine", requireUser, wrap(async (req, res) => {
  const q = await pool.query(`SELECT ${SEL} FROM businesses WHERE owner = $1 ORDER BY bought_at`, [userOf(req).id]);
  res.json({ mine: q.rows.map(view), types: BIZ_TYPES, levels: LEVEL_MULT, upgrade: UPGRADE_COST, max: MAX_BIZ });
}));
// buy a business: { key, type, label, base }
business.post("/biz/buy", requireUser, wrap(async (req, res) => {
  const me = userOf(req), key = String(req.body?.key || ""), type = String(req.body?.type || ""), label = String(req.body?.label || "").slice(0, 40), T = BIZ_TYPES[type];
  if (!KEY_RE.test(key) || !T) return fail(res, 400, "There's no business there");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const w = await wallet(c, me.id, true);
    if (w.synced_at && req.body?.base !== w.version) { await c.query("ROLLBACK"); return stale(res, me.id); }
    if ((await c.query("SELECT count(*)::int AS n FROM businesses WHERE owner = $1", [me.id])).rows[0].n >= MAX_BIZ) { await c.query("ROLLBACK"); return fail(res, 429, `You run ${MAX_BIZ} businesses already. Sell one first`); }
    const had = (await c.query("SELECT u.display_name AS owner FROM businesses b JOIN users u ON u.id = b.owner WHERE b.key = $1", [key])).rows[0];
    if (had) { await c.query("ROLLBACK"); return fail(res, 409, `${had.owner} owns it already`); }
    if (w.money < T[1]) { await c.query("ROLLBACK"); return fail(res, 402, `The ${T[0].toLowerCase()} is ${naira(T[1])}; you have ${naira(w.money)}`); }
    const u = (await c.query("UPDATE wallets SET money = money - $2, version = version + 1, updated_at = now() WHERE user_id = $1 RETURNING version, money::float8 AS money", [me.id, T[1]])).rows[0];
    const b = (await c.query(`INSERT INTO businesses (key, type, label, owner, invested) VALUES ($1, $2, $3, $4, $5) RETURNING ${SEL}`, [key, type, label || T[0], me.id, T[1]])).rows[0];
    await c.query("COMMIT");
    res.status(201).json({ ok: true, biz: view(b), ...moneyOut(u) });
  } catch (e: any) { await c.query("ROLLBACK").catch(() => {}); if (e?.code === "23505") return fail(res, 409, "Someone has just bought it"); throw e; } finally { c.release(); }
}));
// the rest act on one of yours: { key, base, ... }
async function mine(req: Request, res: Response, act: (c: any, b: Row, w: any) => Promise<object | null>) {
  const me = userOf(req), key = String(req.body?.key || ""), c = await pool.connect();
  try {
    await c.query("BEGIN");
    const w = await wallet(c, me.id, true);
    if (w.synced_at && req.body?.base !== w.version) { await c.query("ROLLBACK"); return stale(res, me.id); }
    const b = (await c.query(`SELECT ${SEL} FROM businesses WHERE key = $1 AND owner = $2 FOR UPDATE`, [key, me.id])).rows[0] as Row | undefined;
    if (!b) { await c.query("ROLLBACK"); return fail(res, 404, "That isn't yours"); }
    const out = await act(c, b, w);
    if (!out) { await c.query("ROLLBACK"); return; }
    await c.query("COMMIT");
    res.json(out);
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
const pay = async (c: any, id: string, n: number) => (await c.query("UPDATE wallets SET money = money + $2, version = version + 1, updated_at = now() WHERE user_id = $1 RETURNING version, money::float8 AS money", [id, n])).rows[0];
const reload = async (c: any, key: string) => (await c.query(`SELECT ${SEL} FROM businesses WHERE key = $1`, [key])).rows[0] as Row;
business.post("/biz/collect", requireUser, wrap((req, res) => mine(req, res, async (c, b) => {
  const t = till(b), s = surprise(b, t), total = Math.max(0, t + (s?.delta ?? 0));
  const rep = hours(b) < 1 ? b.rep : Math.max(-100, Math.min(100, b.rep + (b.mode === "low" ? 3 : b.mode === "high" ? -3 : b.rep < 40 ? 1 : 0)));   // the street makes up its mind over hours, not clicks
  await c.query("UPDATE businesses SET last_collect = now(), earned = earned + $2, rep = $3 WHERE key = $1", [b.key, total, rep]);
  const u = await pay(c, userOf(req).id, total);
  return { ok: true, collected: total, till: t, surprise: s, biz: view(await reload(c, b.key)), ...moneyOut(u) };
})));
business.post("/biz/upgrade", requireUser, wrap((req, res) => mine(req, res, async (c, b, w) => {
  if (b.level >= 5) { fail(res, 400, "It's as big as it gets"); return null; }
  const cost = Math.round(BIZ_TYPES[b.type][1] * UPGRADE_COST[b.level + 1]);
  if (w.money < cost) { fail(res, 402, `The upgrade is ${naira(cost)}; you have ${naira(w.money)}`); return null; }
  const t = till(b);   // the till is banked first, so an upgrade never loses what's there
  await c.query("UPDATE businesses SET level = level + 1, invested = invested + $2, last_collect = now(), earned = earned + $3 WHERE key = $1", [b.key, cost, t]);
  const u = await pay(c, userOf(req).id, t - cost);
  return { ok: true, cost, collected: t, biz: view(await reload(c, b.key)), ...moneyOut(u) };
})));
business.post("/biz/manager", requireUser, wrap((req, res) => mine(req, res, async (c, b, w) => {
  if (b.manager) { fail(res, 400, "It has a manager"); return null; }
  const cost = Math.round(BIZ_TYPES[b.type][1] * MANAGER_SHARE);
  if (w.money < cost) { fail(res, 402, `A manager costs ${naira(cost)}; you have ${naira(w.money)}`); return null; }
  await c.query("UPDATE businesses SET manager = true, invested = invested + $2 WHERE key = $1", [b.key, cost]);
  const u = await pay(c, userOf(req).id, -cost);
  return { ok: true, cost, biz: view(await reload(c, b.key)), ...moneyOut(u) };
})));
business.post("/biz/mode", requireUser, wrap((req, res) => mine(req, res, async (c, b) => {
  const mode = String(req.body?.mode || ""); if (!(mode in MODE_K)) { fail(res, 400, "Low, fair or high"); return null; }
  const t = till(b);   // prices change from now: what's in the till so far is banked at the old ones
  await c.query("UPDATE businesses SET mode = $2, last_collect = now(), earned = earned + $3 WHERE key = $1", [b.key, mode, t]);
  const u = await pay(c, userOf(req).id, t);
  return { ok: true, collected: t, biz: view(await reload(c, b.key)), ...moneyOut(u) };
})));
business.post("/biz/sell", requireUser, wrap((req, res) => mine(req, res, async (c, b) => {
  const t = till(b), back = Math.round(+b.invested * SELL_BACK / 100) * 100;
  await c.query("DELETE FROM businesses WHERE key = $1", [b.key]);
  const u = await pay(c, userOf(req).id, back + t);
  return { ok: true, back, collected: t, ...moneyOut(u) };
})));
