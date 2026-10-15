import { Router, type Request, type Response, type NextFunction } from "express";
import type { PoolClient } from "pg";
import { pool } from "./db";
import { requireUser, type TokenUser } from "./auth";
import { PLOTS, BIG_KEYS, HOUSES, CARS, unitsOf } from "./catalog";
import { wallet, stateOf, announce, tell, type PlotNews } from "./land";
import { valueOf, MIN_AGE_H } from "./trade";

/* Cars you own, and the player market.
   Garage: buy a car at a showroom (the server prices it), have it with you anywhere, sell it back to a dealer for 60%.
   Market: put land (with its house) or a car up for sale, at a fixed price or by auction (1 h to 3 days). Buying at a
   fixed price moves the money and the thing at once. A bid's money is held from the bidder's wallet; when someone bids
   higher it goes back to them (on their next sync), and when the auction ends the winner gets the thing and the seller
   the money. The same guards as trading: accounts a day old, prices capped near what things are worth, and a daily cap
   on what one account can spend on the market, so new accounts can't be emptied into one. */
export const market = Router();
const userOf = (req: Request) => (req as Request & { user: TokenUser }).user;
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
const fail = (res: Response, code: number, error: string, extra: object = {}) => res.status(code).json({ error, ...extra });
const naira = (n: number) => "₦" + Math.round(n).toLocaleString("en-NG");
type Q = PoolClient | typeof pool;
export const MARKET_CAP = 20_000_000, MAX_LISTINGS = 10, MAX_CARS = 12, DEALER_BACK = .6;
const HOURS = new Set([1, 6, 24, 72]);
const minNext = (top: number) => top + Math.max(1000, Math.ceil(top * .05 / 100) * 100);   // a bid must beat the last by 5% (at least ₦1,000)

async function oldEnough(c: Q, id: string) { return (await c.query(`SELECT created_at < now() - interval '${MIN_AGE_H} hours' AS ok FROM users WHERE id = $1`, [id])).rows[0]?.ok === true; }
// what you've spent on the market today, and what your leading bids are holding
async function committed(c: Q, id: string) {
  const a = +(await c.query("SELECT COALESCE(SUM(amount), 0)::float8 AS s FROM payments WHERE payer = $1 AND kind = 'market' AND created_at > now() - interval '24 hours'", [id])).rows[0].s;
  const b = +(await c.query("SELECT COALESCE(SUM(top_bid), 0)::float8 AS s FROM listings WHERE top_bidder = $1 AND status = 'open'", [id])).rows[0].s;
  return a + b;
}
const plotKeys = async (c: Q, key: string) => {
  if (PLOTS[key]?.[1] === "b") return BIG_KEYS;
  if (PLOTS[key]?.[1] !== "u") return [key];
  const h = (await c.query("SELECT house FROM plots WHERE key = $1", [key])).rows[0]?.house; return unitsOf(key, h) ?? [key];
};
const stale = async (res: Response, id: string) => fail(res, 409, "Your land changed: syncing first", { stale: true, state: await stateOf(pool, id) });
const moneyOut = (w: { version: number; money: number }) => ({ version: w.version, money: Math.round(w.money) });

/* ---------- the garage ---------- */
market.get("/garage", requireUser, wrap(async (req, res) => {
  const me = userOf(req);
  const q = await pool.query(`SELECT v.id, v.model, v.color, v.paid::float8 AS paid, EXISTS (SELECT 1 FROM listings l WHERE l.kind = 'car' AND l.ref = v.id::text AND l.status = 'open') AS listed
    FROM vehicles v WHERE v.owner = $1 ORDER BY v.created_at`, [me.id]);
  res.json({ cars: q.rows.map((r) => ({ id: r.id, model: r.model, name: CARS[r.model]?.name ?? r.model, color: r.color, paid: Math.round(r.paid), listed: r.listed })), catalog: CARS });
}));
// buy a new car: { model, color, base }
market.post("/garage/buy", requireUser, wrap(async (req, res) => {
  const me = userOf(req), model = String(req.body?.model || ""), car = CARS[model], color = Math.max(0, Math.min(0xffffff, Math.round(+req.body?.color || 0)));
  if (!car) return fail(res, 400, "The showroom doesn't sell that");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const w = await wallet(c, me.id, true);
    if (w.synced_at && req.body?.base !== w.version) { await c.query("ROLLBACK"); return stale(res, me.id); }
    if ((await c.query("SELECT count(*)::int AS n FROM vehicles WHERE owner = $1", [me.id])).rows[0].n >= MAX_CARS) { await c.query("ROLLBACK"); return fail(res, 429, `Your garage holds ${MAX_CARS} cars. Sell one first`); }
    if (w.money < car.price) { await c.query("ROLLBACK"); return fail(res, 402, `The ${car.name} is ${naira(car.price)}; you have ${naira(w.money)}`); }
    const u = (await c.query("UPDATE wallets SET money = money - $2, version = version + 1, updated_at = now() WHERE user_id = $1 RETURNING version, money::float8 AS money", [me.id, car.price])).rows[0];
    const v = (await c.query("INSERT INTO vehicles (owner, model, color, paid) VALUES ($1, $2, $3, $4) RETURNING id", [me.id, model, color, car.price])).rows[0];
    await c.query("COMMIT");
    res.status(201).json({ ok: true, car: { id: v.id, model, name: car.name, color, paid: car.price, listed: false }, ...moneyOut(u) });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}));
// sell a car back to a dealer for 60% of what you paid: { base }
market.post("/garage/:id/sell", requireUser, wrap(async (req, res) => {
  const me = userOf(req), c = await pool.connect();
  try {
    await c.query("BEGIN");
    const w = await wallet(c, me.id, true);
    if (w.synced_at && req.body?.base !== w.version) { await c.query("ROLLBACK"); return stale(res, me.id); }
    const v = (await c.query("SELECT id, model, paid::float8 AS paid FROM vehicles WHERE id = $1 AND owner = $2 FOR UPDATE", [req.params.id, me.id]).catch(() => ({ rows: [] as any[] }))).rows[0];
    if (!v) { await c.query("ROLLBACK"); return fail(res, 404, "That isn't your car"); }
    if ((await c.query("SELECT 1 FROM listings WHERE kind = 'car' AND ref = $1 AND status = 'open'", [v.id])).rowCount) { await c.query("ROLLBACK"); return fail(res, 409, "It's on the market: take it off first"); }
    const back = Math.round(v.paid * DEALER_BACK / 100) * 100;
    await c.query("DELETE FROM vehicles WHERE id = $1", [v.id]);
    const u = (await c.query("UPDATE wallets SET money = money + $2, version = version + 1, updated_at = now() WHERE user_id = $1 RETURNING version, money::float8 AS money", [me.id, back])).rows[0];
    await c.query("COMMIT");
    res.json({ ok: true, back, ...moneyOut(u) });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}));

/* ---------- the market ---------- */
async function describe(rows: any[], me: string) {
  const plots = rows.filter((r) => r.kind === "plot").map((r) => r.ref), cars = rows.filter((r) => r.kind === "car").map((r) => r.ref);
  const ph = plots.length ? (await pool.query("SELECT key, house FROM plots WHERE key = ANY($1)", [plots])).rows : [];
  const ch = cars.length ? (await pool.query("SELECT id::text AS id, model, color FROM vehicles WHERE id::text = ANY($1)", [cars])).rows : [];
  const hOf = new Map(ph.map((r) => [r.key, r.house])), cOf = new Map(ch.map((r) => [r.id, r]));
  return rows.map((r) => {
    const base = { id: r.id, kind: r.kind, ref: r.ref, title: r.title, mode: r.mode, price: Math.round(+r.price), top: r.top_bid == null ? null : Math.round(+r.top_bid), ends: r.ends_at ? +new Date(r.ends_at) : null,
      seller: r.seller_name, mine: r.seller === me, leading: r.top_bidder === me, status: r.status, bids: +r.nbids || 0, next: r.mode === "auction" ? (r.top_bid == null ? Math.round(+r.price) : minNext(Math.round(+r.top_bid))) : null };
    if (r.kind === "plot") { const h = hOf.get(r.ref) ?? null; return { ...base, house: h?.type ?? null, value: valueOf(r.ref, h), big: PLOTS[r.ref]?.[1] === "b" }; }
    const v = cOf.get(r.ref); return { ...base, model: v?.model ?? null, color: v?.color ?? 0, value: v ? CARS[v.model]?.price ?? 0 : 0 };
  });
}
const LIST_SQL = `SELECT l.*, u.display_name AS seller_name, (SELECT count(*) FROM bids b WHERE b.listing = l.id) AS nbids FROM listings l JOIN users u ON u.id = l.seller`;
market.get("/market", requireUser, wrap(async (req, res) => {
  const me = userOf(req);
  const open = (await pool.query(`${LIST_SQL} WHERE l.status = 'open' ORDER BY COALESCE(l.ends_at, l.created_at + interval '30 days') LIMIT 200`)).rows;
  const mine = (await pool.query(`${LIST_SQL} WHERE l.seller = $1 AND l.status <> 'open' ORDER BY l.closed_at DESC NULLS LAST LIMIT 15`, [me.id])).rows;
  const won = (await pool.query(`${LIST_SQL} WHERE l.buyer = $1 ORDER BY l.closed_at DESC LIMIT 10`, [me.id])).rows;
  const w = await wallet(pool, me.id);
  res.json({ open: await describe(open, me.id), history: await describe(mine, me.id), won: await describe(won, me.id), limits: { cap: MARKET_CAP, left: Math.max(0, MARKET_CAP - (await committed(pool, me.id))), canPay: await oldEnough(pool, me.id), money: Math.round(w.money) } });
}));
// put something up: { kind: 'plot' | 'car', ref, mode: 'fixed' | 'auction', price, hours }
market.post("/market", requireUser, wrap(async (req, res) => {
  const me = userOf(req), b = req.body || {}, kind = b.kind, ref = String(b.ref || ""), mode = b.mode === "auction" ? "auction" : "fixed", price = Math.round(+b.price), hours = Math.round(+b.hours || 24);
  if (!Number.isFinite(price) || price < 1000) return fail(res, 400, "Ask at least ₦1,000");
  if (mode === "auction" && !HOURS.has(hours)) return fail(res, 400, "Auctions run 1 hour, 6 hours, a day or 3 days");
  if ((await pool.query("SELECT count(*)::int AS n FROM listings WHERE seller = $1 AND status = 'open'", [me.id])).rows[0].n >= MAX_LISTINGS) return fail(res, 429, `You have ${MAX_LISTINGS} things up already`);
  let title = "", value = 0, refKey = ref;
  if (kind === "plot") {
    if (!PLOTS[ref]) return fail(res, 400, "That isn't a plot");
    const keys = await plotKeys(pool, ref); refKey = keys[0];
    const own = await pool.query("SELECT key, house FROM plots WHERE key = ANY($1) AND owner = $2", [keys, me.id]);
    if (own.rowCount !== keys.length) return fail(res, 409, "You don't own all of that land");
    const house = own.rows.find((r) => r.house)?.house ?? null; value = valueOf(refKey, house);
    const H: Record<string, string> = { cabin: "Cabin", bungalow: "Bungalow", family: "Family house", duplex: "Duplex", mansionette: "Mansionette", mansion: "Mansion" };
    title = (house && HOUSES[house.type] ? H[house.type] || "House" : keys.length > 1 ? "Land" : "Plot of land") + (PLOTS[refKey][1] === "b" ? " · Banana Island" : "");
    if (price > value * 1.5 + 50_000) return fail(res, 400, `That's well over what it's worth (${naira(value)}). Ask at most ${naira(value * 1.5 + 50_000)}`);
  } else if (kind === "car") {
    const v = (await pool.query("SELECT model FROM vehicles WHERE id::text = $1 AND owner = $2", [ref, me.id])).rows[0];
    if (!v) return fail(res, 404, "That isn't your car");
    value = CARS[v.model]?.price ?? 0; title = CARS[v.model]?.name ?? "Car";
    if (price > value * 1.3) return fail(res, 400, `That's well over a new one's price (${naira(value)}). Ask at most ${naira(value * 1.3)}`);
  } else return fail(res, 400, "Sell land or a car");
  const r = await pool.query(`INSERT INTO listings (kind, ref, seller, title, mode, price, ends_at) VALUES ($1, $2, $3, $4, $5, $6, ${mode === "auction" ? `now() + interval '${hours} hours'` : "NULL"}) RETURNING id`,
    [kind, refKey, me.id, title, mode, price]).catch((e) => { if (e.code === "23505") return null; throw e; });
  if (!r) return fail(res, 409, "That's already on the market");
  res.status(201).json({ ok: true, id: r.rows[0].id, value });
}));
market.post("/market/:id/cancel", requireUser, wrap(async (req, res) => {
  const me = userOf(req);
  const q = await pool.query("UPDATE listings SET status = 'cancelled', closed_at = now() WHERE id = $1 AND seller = $2 AND status = 'open' AND top_bidder IS NULL RETURNING id", [req.params.id, me.id]).catch(() => ({ rowCount: 0 }));
  if (!q.rowCount) return fail(res, 409, "It has bids (an auction with bids runs to the end), or it isn't open");
  res.json({ ok: true });
}));
// hand the thing over (in the caller's transaction): the plot(s) or the car to the buyer. False if the seller no longer has it.
async function handOver(c: PoolClient, L: any, buyer: string, buyerName: string, news: PlotNews[], price: number) {
  // a car's "paid" becomes what the new owner paid, so a dealer's buy-back (60% of it) can't turn a cheap sale into money
  if (L.kind === "car") return (await c.query("UPDATE vehicles SET owner = $2, paid = $4 WHERE id::text = $1 AND owner = $3", [L.ref, buyer, L.seller, price])).rowCount === 1;
  const keys = await plotKeys(c, L.ref);
  const own = await c.query("SELECT key, house, edits FROM plots WHERE key = ANY($1) AND owner = $2 FOR UPDATE", [keys, L.seller]);
  if (own.rowCount !== keys.length) return false;
  await c.query("UPDATE plots SET owner = $2, updated_at = now() WHERE key = ANY($1)", [keys, buyer]);
  await c.query("UPDATE offers SET status = 'void', decided_at = now() WHERE key = ANY($1) AND status = 'open'", [keys]);
  // both players' land changed: their games reload it from the server
  await c.query("UPDATE wallets SET version = version + 1 WHERE user_id = ANY($1)", [[buyer, L.seller]]);
  for (const r of own.rows) news.push({ key: r.key, owner: buyer, ownerName: buyerName, npc: false, big: keys.length > 1, house: r.house, edits: r.edits });
  return true;
}
// buy at the asking price: { base }
market.post("/market/:id/buy", requireUser, wrap(async (req, res) => {
  const me = userOf(req), c = await pool.connect(), news: PlotNews[] = [];
  let L: any = null;
  try {
    await c.query("BEGIN");
    L = (await c.query("SELECT * FROM listings WHERE id = $1 FOR UPDATE", [req.params.id]).catch(() => ({ rows: [] as any[] }))).rows[0];
    if (!L || L.status !== "open" || L.mode !== "fixed") { await c.query("ROLLBACK"); return fail(res, 404, "That isn't for sale any more"); }
    if (L.seller === me.id) { await c.query("ROLLBACK"); return fail(res, 400, "That's yours"); }
    const price = Math.round(+L.price);
    if (!(await oldEnough(c, me.id))) { await c.query("ROLLBACK"); return fail(res, 403, `New accounts can buy from other players after ${MIN_AGE_H} hours`); }
    if ((await committed(c, me.id)) + price > MARKET_CAP) { await c.query("ROLLBACK"); return fail(res, 429, `You can spend up to ${naira(MARKET_CAP)} a day on the market`); }
    const [a, b2] = [me.id, L.seller].sort(); const wa = await wallet(c, a, true), wb = await wallet(c, b2, true), wMe = a === me.id ? wa : wb;
    if (wMe.synced_at && req.body?.base !== wMe.version) { await c.query("ROLLBACK"); return stale(res, me.id); }
    if (wMe.money < price) { await c.query("ROLLBACK"); return fail(res, 402, `It's ${naira(price)}; you have ${naira(wMe.money)}`); }
    if (!(await handOver(c, L, me.id, me.name, news, price))) {
      await c.query("UPDATE listings SET status = 'void', closed_at = now() WHERE id = $1", [L.id]); await c.query("COMMIT");
      return fail(res, 409, "The seller doesn't have it any more");
    }
    const u = (await c.query("UPDATE wallets SET money = money - $2, version = version + 1, updated_at = now() WHERE user_id = $1 RETURNING version, money::float8 AS money", [me.id, price])).rows[0];
    await c.query("UPDATE wallets SET inbox = inbox + $2 WHERE user_id = $1", [L.seller, price]);
    await c.query("INSERT INTO payments (payer, payee, amount, kind, ref, seen) VALUES ($1, $2, $3, 'market', $4, false)", [me.id, L.seller, price, L.title]);
    await c.query("UPDATE listings SET status = 'sold', buyer = $2, closed_at = now() WHERE id = $1", [L.id, me.id]);
    await c.query("COMMIT");
    announce(news); tell(L.seller, "market", { kind: "sold", title: L.title, to: me.name, price });
    res.json({ ok: true, kind: L.kind, title: L.title, price, ...moneyOut(u), ...(L.kind === "plot" ? { state: await stateOf(pool, me.id) } : {}) });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}));
// bid: { amount, base }. The money is held; if you were already leading, only the difference is.
market.post("/market/:id/bid", requireUser, wrap(async (req, res) => {
  const me = userOf(req), amount = Math.round(+req.body?.amount), c = await pool.connect();
  let L: any = null, prev: string | null = null, prevAmt = 0;
  try {
    await c.query("BEGIN");
    L = (await c.query("SELECT * FROM listings WHERE id = $1 FOR UPDATE", [req.params.id]).catch(() => ({ rows: [] as any[] }))).rows[0];
    if (!L || L.status !== "open" || L.mode !== "auction" || +new Date(L.ends_at) <= Date.now()) { await c.query("ROLLBACK"); return fail(res, 404, "That auction has ended"); }
    if (L.seller === me.id) { await c.query("ROLLBACK"); return fail(res, 400, "That's yours"); }
    const top = L.top_bid == null ? null : Math.round(+L.top_bid), need = top == null ? Math.round(+L.price) : minNext(top);
    if (!Number.isFinite(amount) || amount < need) { await c.query("ROLLBACK"); return fail(res, 400, `Bid at least ${naira(need)}`); }
    if (!(await oldEnough(c, me.id))) { await c.query("ROLLBACK"); return fail(res, 403, `New accounts can bid after ${MIN_AGE_H} hours`); }
    prev = L.top_bidder; prevAmt = top ?? 0; const mine = prev === me.id, extra = mine ? amount - prevAmt : amount;
    if ((await committed(c, me.id)) + extra > MARKET_CAP) { await c.query("ROLLBACK"); return fail(res, 429, `You can commit up to ${naira(MARKET_CAP)} a day on the market`); }
    const w = await wallet(c, me.id, true);
    if (w.synced_at && req.body?.base !== w.version) { await c.query("ROLLBACK"); return stale(res, me.id); }
    if (w.money < extra) { await c.query("ROLLBACK"); return fail(res, 402, `You'd need ${naira(extra)} free; you have ${naira(w.money)}`); }
    const u = (await c.query("UPDATE wallets SET money = money - $2, version = version + 1, updated_at = now() WHERE user_id = $1 RETURNING version, money::float8 AS money", [me.id, extra])).rows[0];
    if (prev && !mine) await c.query("UPDATE wallets SET inbox = inbox + $2 WHERE user_id = $1", [prev, prevAmt]);   // the old top bid goes back
    const late = +new Date(L.ends_at) - Date.now() < 120_000;   // a bid in the last two minutes adds two (no sniping)
    await c.query(`UPDATE listings SET top_bid = $2, top_bidder = $3${late ? ", ends_at = ends_at + interval '2 minutes'" : ""} WHERE id = $1`, [L.id, amount, me.id]);
    await c.query("INSERT INTO bids (listing, bidder, amount) VALUES ($1, $2, $3)", [L.id, me.id, amount]);
    await c.query("COMMIT");
    if (prev && !mine) tell(prev, "market", { kind: "outbid", title: L.title, by: me.name, amount, id: L.id });
    tell(L.seller, "market", { kind: "bid", title: L.title, by: me.name, amount });
    res.json({ ok: true, amount, extended: late, ...moneyOut(u) });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}));

/* ---------- auctions that have ended: the winner gets it, the seller the money (or the bid goes back if the seller no longer has it) ---------- */
export async function settleAuctions() {
  const due = (await pool.query("SELECT id FROM listings WHERE status = 'open' AND mode = 'auction' AND ends_at <= now() LIMIT 20")).rows;
  for (const { id } of due) {
    const c = await pool.connect(), news: PlotNews[] = [];
    let L: any = null, outcome = "";
    try {
      await c.query("BEGIN");
      L = (await c.query("SELECT l.*, u.display_name AS winner_name FROM listings l LEFT JOIN users u ON u.id = l.top_bidder WHERE l.id = $1 AND l.status = 'open' FOR UPDATE OF l SKIP LOCKED", [id])).rows[0];
      if (!L) { await c.query("ROLLBACK"); continue; }
      const amt = Math.round(+(L.top_bid || 0));
      if (!L.top_bidder) { await c.query("UPDATE listings SET status = 'expired', closed_at = now() WHERE id = $1", [id]); outcome = "expired"; }
      else if (await handOver(c, L, L.top_bidder, L.winner_name, news, amt)) {
        await c.query("UPDATE wallets SET inbox = inbox + $2 WHERE user_id = $1", [L.seller, amt]);
        await c.query("INSERT INTO payments (payer, payee, amount, kind, ref, seen) VALUES ($1, $2, $3, 'market', $4, false)", [L.top_bidder, L.seller, amt, L.title]);
        await c.query("UPDATE listings SET status = 'sold', buyer = top_bidder, closed_at = now() WHERE id = $1", [id]); outcome = "sold";
      } else {
        await c.query("UPDATE wallets SET inbox = inbox + $2 WHERE user_id = $1", [L.top_bidder, amt]);
        await c.query("UPDATE listings SET status = 'void', closed_at = now() WHERE id = $1", [id]); outcome = "void";
      }
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); console.error("settle", e); continue; } finally { c.release(); }
    announce(news);
    if (outcome === "sold") { tell(L.top_bidder, "market", { kind: "won", title: L.title, price: Math.round(+L.top_bid), plot: L.kind === "plot" }); tell(L.seller, "market", { kind: "sold", title: L.title, to: L.winner_name, price: Math.round(+L.top_bid) }); }
    else if (outcome === "expired") tell(L.seller, "market", { kind: "unsold", title: L.title });
    else if (outcome === "void") tell(L.top_bidder, "market", { kind: "void", title: L.title, amount: Math.round(+L.top_bid) });
  }
}
