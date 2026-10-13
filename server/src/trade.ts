import { Router, type Request, type Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "./db";
import { requireUser, type TokenUser } from "./auth";
import { PLOTS, BIG_KEYS, HOUSES, FURN, BATH_ITEMS, fenceCost } from "./catalog";
import { wallet, stateOf, announce, tell, type PlotNews } from "./land";

/* Players dealing with each other: offer your land (with its house) to another player for a price, or as a gift,
   and send money. Every account starts with ₦10,000,000, so to stop new accounts being emptied into one, what leaves
   an account (money sent, money paid for land, and the value of land given away below its worth) is capped per day,
   and an account must be a day old before it can send or pay anything. */
export const trade = Router();
const userOf = (req: Request) => (req as Request & { user: TokenUser }).user;
export const OUT_CAP = 1_000_000, MIN_AGE_H = 24, MAX_OPEN = 10;
const DAY = "now() - interval '24 hours'";

// what a plot is worth: the land, the house, its furnishing, fence and furniture bought (the Banana Island lot counts whole)
export function valueOf(key: string, house: any): number {
  const keys = PLOTS[key]?.[1] === "b" ? BIG_KEYS : [key];
  let v = keys.reduce((a, k) => a + (PLOTS[k]?.[0] || 0), 0);
  const t = house && HOUSES[house.type];
  if (t) {
    v += t.cost + (house.bare === false ? t.furnish : 0) + fenceCost(t, house.fence);
    for (const f of house.furn || []) if (f && FURN[f.id] && !BATH_ITEMS.has(f.id)) v += FURN[f.id];   // bathroom fittings come free with the bathroom
  }
  return v;
}
const keysOf = (key: string) => (PLOTS[key]?.[1] === "b" ? BIG_KEYS : [key]);
const naira = (n: number) => "₦" + Math.round(n).toLocaleString("en-NG");

async function outToday(c: PoolClient | typeof pool, id: string) {
  return +(await c.query(`SELECT COALESCE(SUM(amount), 0)::float8 AS s FROM payments WHERE payer = $1 AND created_at > ${DAY}`, [id])).rows[0].s;
}
async function oldEnough(c: PoolClient | typeof pool, id: string) {
  return (await c.query(`SELECT created_at < now() - interval '${MIN_AGE_H} hours' AS ok FROM users WHERE id = $1`, [id])).rows[0]?.ok === true;
}
async function userNamed(c: PoolClient | typeof pool, name: unknown) {
  if (typeof name !== "string" || !name.trim()) return null;
  return (await c.query("SELECT id, display_name AS name FROM users WHERE lower(display_name) = lower($1)", [name.trim()])).rows[0] as { id: string; name: string } | undefined ?? null;
}
const fail = (res: Response, code: number, error: string, extra: object = {}) => res.status(code).json({ error, ...extra });

// your open offers, both ways, and how much more you can send today
trade.get("/trade/offers", requireUser, async (req, res) => {
  const me = userOf(req);
  const q = await pool.query(`SELECT o.id, o.key, o.price::float8 AS price, o.seller, o.buyer, s.display_name AS seller_name, b.display_name AS buyer_name, p.house
    FROM offers o JOIN users s ON s.id = o.seller JOIN users b ON b.id = o.buyer LEFT JOIN plots p ON p.key = o.key
    WHERE o.status = 'open' AND (o.seller = $1 OR o.buyer = $1) ORDER BY o.created_at DESC`, [me.id]);
  const row = (r: any) => ({ id: r.id, key: r.key, price: r.price, house: r.house?.type ?? null, value: valueOf(r.key, r.house), big: PLOTS[r.key]?.[1] === "b" });
  const out = await outToday(pool, me.id);
  res.json({
    incoming: q.rows.filter((r) => r.buyer === me.id).map((r) => ({ ...row(r), from: r.seller_name })),
    outgoing: q.rows.filter((r) => r.seller === me.id).map((r) => ({ ...row(r), to: r.buyer_name })),
    limits: { cap: OUT_CAP, left: Math.max(0, OUT_CAP - out), canPay: await oldEnough(pool, me.id) },
  });
});

// offer one of your plots to a player: { key, to: their name, price } (price 0 = a gift)
trade.post("/trade/offers", requireUser, async (req, res) => {
  const me = userOf(req), { key, to } = req.body || {}, price = Math.round(+req.body?.price);
  if (typeof key !== "string" || !PLOTS[key]) return fail(res, 400, "That isn't a plot");
  if (!Number.isFinite(price) || price < 0 || price > 50_000_000) return fail(res, 400, "Pick a price from ₦0 (a gift) to ₦50,000,000");
  const buyer = await userNamed(pool, to);
  if (!buyer) return fail(res, 404, `There's no player called ${String(to || "").slice(0, 24)}`);
  if (buyer.id === me.id) return fail(res, 400, "That's you");
  const keys = keysOf(key);
  const own = await pool.query("SELECT key, house FROM plots WHERE key = ANY($1) AND owner = $2", [keys, me.id]);
  if (own.rowCount !== keys.length) return fail(res, 409, keys.length > 1 ? "You don't own the whole Banana Island lot" : "You don't own that plot (if you just bought it, wait a moment for it to save)");
  const house = own.rows.find((r) => r.house)?.house ?? null, value = valueOf(key, house);
  if (price > value * 2 + 50_000) return fail(res, 400, `That's more than twice what it's worth (${naira(value)}). Ask at most ${naira(value * 2 + 50_000)}`);
  const open = await pool.query("SELECT count(*)::int AS n FROM offers WHERE seller = $1 AND status = 'open'", [me.id]);
  if (open.rows[0].n >= MAX_OPEN) return fail(res, 429, `You have ${MAX_OPEN} offers open already. Cancel one first`);
  // one open offer per plot: a new one replaces the old
  await pool.query("UPDATE offers SET status = 'cancelled', decided_at = now() WHERE key = ANY($1) AND seller = $2 AND status = 'open'", [keys, me.id]);
  const o = await pool.query("INSERT INTO offers (key, seller, buyer, price) VALUES ($1, $2, $3, $4) RETURNING id", [keys[0], me.id, buyer.id, price]);
  tell(buyer.id, "trade", { kind: "offer", from: me.name, key: keys[0], price, house: house?.type ?? null, big: keys.length > 1 });
  res.status(201).json({ ok: true, id: o.rows[0].id, to: buyer.name, value });
});

// the buyer takes it: { base: the land version their game last saw }. The plot, its house and the money move together.
trade.post("/trade/offers/:id/accept", requireUser, async (req, res) => {
  const me = userOf(req), base = req.body?.base;
  const c = await pool.connect(), news: PlotNews[] = [];
  let sellerId = "", key = "", price = 0;
  try {
    await c.query("BEGIN");
    const o = (await c.query("SELECT * FROM offers WHERE id = $1 FOR UPDATE", [req.params.id]).catch(() => ({ rows: [] as any[] }))).rows[0];
    if (!o || o.buyer !== me.id || o.status !== "open") { await c.query("ROLLBACK"); return fail(res, 404, "That offer isn't open any more"); }
    sellerId = o.seller; key = o.key; price = Math.round(+o.price);
    // lock both wallets in a fixed order, so two deals between the same people can't deadlock
    const [a, b] = [me.id, sellerId].sort();
    const wa = await wallet(c, a, true), wb = await wallet(c, b, true), wMe = a === me.id ? wa : wb;
    if (wMe.synced_at && base !== wMe.version) { await c.query("ROLLBACK"); return fail(res, 409, "Your land changed: syncing first", { stale: true, state: await stateOf(pool, me.id) }); }
    const keys = keysOf(key);
    const own = await c.query("SELECT key, house, edits FROM plots WHERE key = ANY($1) AND owner = $2 FOR UPDATE", [keys, sellerId]);
    if (own.rowCount !== keys.length) {
      await c.query("UPDATE offers SET status = 'void', decided_at = now() WHERE id = $1", [o.id]); await c.query("COMMIT");
      return fail(res, 409, "The seller doesn't own that land any more");
    }
    const house = own.rows.find((r) => r.house)?.house ?? null, value = valueOf(key, house);
    if (price > 0 && !(await oldEnough(c, me.id))) { await c.query("ROLLBACK"); return fail(res, 403, `New accounts can't pay other players for ${MIN_AGE_H} hours`); }
    if (wMe.money < price) { await c.query("ROLLBACK"); return fail(res, 402, `You need ${naira(price)}; you have ${naira(wMe.money)}`); }
    if (price > 0 && (await outToday(c, me.id)) + price > OUT_CAP) { await c.query("ROLLBACK"); return fail(res, 429, `You can pay other players up to ${naira(OUT_CAP)} a day`); }
    const given = Math.max(0, value - price);   // land handed over below its worth counts against the seller's day
    if (given > 0 && (await outToday(c, sellerId)) + given > OUT_CAP) { await c.query("ROLLBACK"); return fail(res, 429, `The seller can't give away more than ${naira(OUT_CAP)} of value a day. Ask them for a higher price, or try tomorrow`); }
    // move it: the land to you, the money to them; both their games reload their land from the server
    await c.query("UPDATE plots SET owner = $2, updated_at = now() WHERE key = ANY($1)", [keys, me.id]);
    await c.query("UPDATE wallets SET money = money - $2, version = version + 1, updated_at = now() WHERE user_id = $1", [me.id, price]);
    await c.query("UPDATE wallets SET money = money + $2, version = version + 1, updated_at = now() WHERE user_id = $1", [sellerId, price]);
    if (price > 0) await c.query("INSERT INTO payments (payer, payee, amount, kind, ref, seen) VALUES ($1, $2, $3, 'land', $4, false)", [me.id, sellerId, price, key]);
    if (given > 0) await c.query("INSERT INTO payments (payer, payee, amount, kind, ref, seen) VALUES ($1, $2, $3, 'giveaway', $4, true)", [sellerId, me.id, given, key]);
    await c.query("UPDATE offers SET status = 'accepted', decided_at = now() WHERE id = $1", [o.id]);
    await c.query("UPDATE offers SET status = 'void', decided_at = now() WHERE key = ANY($1) AND status = 'open' AND id <> $2", [keys, o.id]);
    for (const r of own.rows) news.push({ key: r.key, owner: me.id, ownerName: me.name, npc: false, big: keys.length > 1, house: r.house, edits: r.edits });
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  announce(news);
  tell(sellerId, "trade", { kind: "sold", to: me.name, key, price });
  res.json({ ok: true, key, price, state: await stateOf(pool, me.id) });
});

trade.post("/trade/offers/:id/:act(decline|cancel)", requireUser, async (req, res) => {
  const me = userOf(req), decline = req.params.act === "decline";
  const q = await pool.query(`UPDATE offers SET status = $3, decided_at = now() WHERE id = $1 AND status = 'open' AND ${decline ? "buyer" : "seller"} = $2
    RETURNING key, seller, buyer`, [req.params.id, me.id, decline ? "declined" : "cancelled"]).catch(() => ({ rows: [] as any[], rowCount: 0 }));
  if (!q.rowCount) return fail(res, 404, "That offer isn't open any more");
  const o = q.rows[0];
  tell(decline ? o.seller : o.buyer, "trade", { kind: decline ? "declined" : "withdrawn", by: me.name, key: o.key });
  res.json({ ok: true });
});

// send money to a player: { to: their name, amount, base }. It reaches them on their next sync (straight away if they're online).
trade.post("/trade/pay", requireUser, async (req, res) => {
  const me = userOf(req), amount = Math.round(+req.body?.amount), base = req.body?.base;
  if (!Number.isFinite(amount) || amount < 100) return fail(res, 400, "Send at least ₦100");
  const to = await userNamed(pool, req.body?.to);
  if (!to) return fail(res, 404, `There's no player called ${String(req.body?.to || "").slice(0, 24)}`);
  if (to.id === me.id) return fail(res, 400, "That's you");
  const c = await pool.connect();
  let left = 0, version = 0, money = 0;
  try {
    await c.query("BEGIN");
    const w = await wallet(c, me.id, true);
    if (w.synced_at && base !== w.version) { await c.query("ROLLBACK"); return fail(res, 409, "Your land changed: syncing first", { stale: true, state: await stateOf(pool, me.id) }); }
    if (!(await oldEnough(c, me.id))) { await c.query("ROLLBACK"); return fail(res, 403, `New accounts can't send money for ${MIN_AGE_H} hours`); }
    if (w.money < amount) { await c.query("ROLLBACK"); return fail(res, 402, `You have ${naira(w.money)}`); }
    const out = await outToday(c, me.id);
    if (out + amount > OUT_CAP) { await c.query("ROLLBACK"); return fail(res, 429, `You can send up to ${naira(OUT_CAP)} a day; ${naira(Math.max(0, OUT_CAP - out))} left today`); }
    await wallet(c, to.id);   // make sure they have a wallet
    const r = await c.query("UPDATE wallets SET money = money - $2, version = version + 1, updated_at = now() WHERE user_id = $1 RETURNING version, money::float8 AS money", [me.id, amount]);
    await c.query("UPDATE wallets SET inbox = inbox + $2 WHERE user_id = $1", [to.id, amount]);
    await c.query("INSERT INTO payments (payer, payee, amount, kind) VALUES ($1, $2, $3, 'gift')", [me.id, to.id, amount]);
    await c.query("COMMIT");
    version = r.rows[0].version; money = Math.round(r.rows[0].money); left = OUT_CAP - out - amount;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  tell(to.id, "trade", { kind: "paid", from: me.name, amount });
  res.json({ ok: true, to: to.name, amount, version, money, left });
});
