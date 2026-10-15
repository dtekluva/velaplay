import { Router, type Request } from "express";
import type { PoolClient } from "pg";
import { pool } from "./db";
import { requireUser, type TokenUser } from "./auth";
import { PLOTS, BIG_KEYS, START_MONEY, DOZER_PRICE, HOUSES, FURN, BATH_ITEMS, fenceCost, plotOfCell, isUnit, unitsOf } from "./catalog";

/* Shared ownership. The game keeps playing as before and, after each change, sends its land record (money, plots with
   their houses, furniture and fences, the bulldozer, terrain edits) along with the version it last saw. The server
   works out what changed, checks and prices every change from its own tables, and stores the result as the truth. */
export const land = Router();
const userOf = (req: Request) => (req as Request & { user: TokenUser }).user;
type Plot = { paid: number; big?: boolean; house: any | null };
type Edits = Record<string, number>;
export interface PlotNews { key: string; owner: string | null; ownerName: string | null; npc: boolean; big: boolean; house: any | null; edits: Edits }

// rooms register a listener so every change reaches everyone online
const listeners = new Set<(news: PlotNews[]) => void>();
export const onPlotNews = (fn: (news: PlotNews[]) => void) => { listeners.add(fn); return () => listeners.delete(fn); };
export const announce = (news: PlotNews[]) => { if (news.length) for (const fn of listeners) fn(news); };
// a message for one player (an offer, a payment, a sale), delivered by whichever room they're in
const tellers = new Set<(userId: string, type: string, data: unknown) => void>();
export const onTell = (fn: (userId: string, type: string, data: unknown) => void) => { tellers.add(fn); return () => tellers.delete(fn); };
export const tell = (userId: string, type: string, data: unknown) => { for (const fn of tellers) fn(userId, type, data); };

// everything that is owned or sold on, for drawing other people's homes
land.get("/world", async (_req, res) => {
  const q = await pool.query(`SELECT p.key, p.owner, u.display_name AS owner_name, p.npc, p.big, p.house, p.edits FROM plots p
    LEFT JOIN users u ON u.id = p.owner WHERE p.owner IS NOT NULL OR p.npc`);
  res.json({ plots: q.rows.map((r) => ({ key: r.key, owner: r.owner, ownerName: r.owner_name, npc: r.npc, big: r.big, house: r.house, edits: r.edits })) });
});

export async function wallet(c: PoolClient | typeof pool, id: string, lock = false) {
  await c.query("INSERT INTO wallets (user_id, money) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, START_MONEY]);
  return (await c.query(`SELECT money::float8 AS money, inbox::float8 AS inbox, dozer, version, synced_at, updated_at FROM wallets WHERE user_id = $1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0];
}
export async function stateOf(c: PoolClient | typeof pool, id: string) {
  const w = await wallet(c, id);
  const q = await c.query("SELECT key, paid, big, house, edits FROM plots WHERE owner = $1", [id]);
  const plots: Record<string, Plot> = {}, edits: Edits = {};
  for (const r of q.rows) { plots[r.key] = { paid: r.paid, big: r.big || undefined, house: r.house }; Object.assign(edits, r.edits); }
  return { money: Math.round(w.money), dozer: w.dozer, version: w.version, imported: !!w.synced_at, plots, edits };
}
// who paid you (money sent, land they bought from you) since you were last told
async function takeReceived(c: PoolClient | typeof pool, id: string) {
  return (await c.query(`UPDATE payments p SET seen = true FROM users u WHERE p.payee = $1 AND NOT p.seen AND u.id = p.payer
    RETURNING u.display_name AS from, p.amount::float8 AS amount, p.kind, p.ref`, [id])).rows;
}
land.get("/land/state", requireUser, async (req, res) => res.json(await stateOf(pool, userOf(req).id)));

// a house's furniture as counts per piece
const tally = (furn: any[] | undefined) => { const m = new Map<string, number>(); for (const f of furn || []) if (f && typeof f.id === "string") m.set(f.id, (m.get(f.id) || 0) + 1); return m; };
const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// the most a player can plausibly have earned since their last accepted change (jobs, fares, tours, daily pay)
const earnCap = (since: Date) => Math.min(2_000_000, 80_000 + 2_500 * Math.max(0, (Date.now() - since.getTime()) / 1000));

land.post("/land/sync", requireUser, async (req, res) => {
  const me = userOf(req), body = req.body || {}, s = body.state || {};
  if (typeof s !== "object" || typeof s.plots !== "object" || !Number.isFinite(s.money)) return res.status(400).json({ error: "Bad land record" });
  const wantPlots: Record<string, Plot> = s.plots, wantEdits: Edits = s.edits && typeof s.edits === "object" ? s.edits : {};
  const c = await pool.connect(), news: PlotNews[] = [], conflicts: { key: string; owner: string | null }[] = [], notes: string[] = [];
  try {
    await c.query("BEGIN");
    const w = await wallet(c, me.id, true), importing = !w.synced_at;
    // someone else (another device) changed things since this client last looked: send the truth back instead
    if (!importing && body.base !== w.version) {
      await c.query("ROLLBACK");
      return res.status(409).json({ stale: true, state: await stateOf(pool, me.id), received: await takeReceived(pool, me.id) });
    }
    const old = await stateOf(c, me.id);
    let cost = 0, credit = 0, refund = 0;   // refund: what the game already deducted for things the server turned down
    const keep: Record<string, Plot> = {};
    const claim = async (key: string, p: Plot) => {   // take a free plot; false if someone already has it
      const r = await c.query(`INSERT INTO plots (key, owner, paid, big, house, updated_at) VALUES ($1, $2, $3, $4, NULL, now())
        ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner, paid = EXCLUDED.paid, big = EXCLUDED.big, house = NULL, edits = '{}'::jsonb, npc = false, updated_at = now()
        WHERE plots.owner IS NULL AND NOT plots.npc RETURNING key`, [key, me.id, p.paid, !!p.big]);
      if (r.rowCount) return true;
      const o = await c.query("SELECT u.display_name FROM plots p LEFT JOIN users u ON u.id = p.owner WHERE p.key = $1", [key]);
      conflicts.push({ key, owner: o.rows[0]?.display_name ?? null }); return false;
    };
    // 1. new plots: real, for sale, free; priced from the server's table (imports of an existing save are free)
    for (const key of Object.keys(wantPlots)) {
      if (old.plots[key]) continue;
      const row = PLOTS[key], p = wantPlots[key];
      // anything the game already paid for on a plot it couldn't have: the plot, and any house, furnishing and fence on it
      const houseSpend = () => { const t = p?.house && HOUSES[p.house.type]; return t ? t.cost + (p.house.bare === false ? t.furnish : 0) + fenceCost(t, p.house.fence, p.house) : 0; };
      if (!row) { conflicts.push({ key, owner: null }); if (!importing) refund += Math.max(0, +p?.paid || 0) + houseSpend(); continue; }
      const price = row[0];
      if (await claim(key, { paid: price, big: row[1] === "b", house: null })) { keep[key] = { paid: price, big: row[1] === "b" || undefined, house: null }; if (!importing) cost += price; }
      else if (!importing) refund += price + houseSpend();
    }
    if (!importing) {
      // the Banana Island lot is bought and sold whole
      const bigNow = BIG_KEYS.filter((k) => keep[k] || (old.plots[k] && wantPlots[k])), bigHad = BIG_KEYS.filter((k) => old.plots[k]);
      if (bigNow.length && bigNow.length !== BIG_KEYS.length && bigHad.length !== bigNow.length) notes.push("Banana Island is bought and sold as one lot");
    }
    // 2. plots you no longer list are sold on: the buyer keeps the house; you get at most what the game could pay
    for (const key of Object.keys(old.plots)) {
      if (wantPlots[key]) continue;
      const o = old.plots[key], t = o.house && HOUSES[o.house.type];
      credit += Math.round(o.paid * 1.5 + (t ? t.cost * .9 : 0));
      await c.query("UPDATE plots SET owner = NULL, npc = true, updated_at = now() WHERE key = $1", [key]);
      news.push({ key, owner: null, ownerName: null, npc: true, big: !!o.big, house: o.house, edits: {} });
    }
    // 3. plots you keep: houses, fences and furniture, each priced
    for (const key of Object.keys(wantPlots)) {
      const now = wantPlots[key], had = old.plots[key] ?? (keep[key] ? { paid: keep[key].paid, house: null } : null);
      if (!had) continue;
      let house = had.house;
      const nh = now.house && typeof now.house === "object" ? now.house : null;
      if (!had.house && nh) {   // a new house
        const t = HOUSES[nh.type];
        const onUnits = isUnit(key), units = onUnits ? unitsOf(key, nh) : null;
        if (!t || !!t.big !== (PLOTS[key]?.[1] === "b") || (onUnits && (!units || !units.every((u) => wantPlots[u])))) { notes.push(`That house can't go on plot ${key}`); if (t && !importing) refund += t.cost + (nh.bare === false ? t.furnish : 0) + fenceCost(t, nh.fence, nh); }
        else {
          if (!importing) cost += t.cost + (nh.bare === false && t.furnish ? t.furnish : 0) + fenceCost(t, nh.fence, nh);
          house = nh;
        }
      } else if (had.house && nh) {   // changes to a house you have
        const t = HOUSES[had.house.type];
        if (nh.type !== had.house.type) notes.push("A house can't change type");
        else if (t) {
          if (!importing && !sameJSON(nh.fence, had.house.fence)) cost += fenceCost(t, nh.fence, nh);
          if (!importing) {
            const a = tally(had.house.furn), b = tally(nh.furn), newBath = !had.house.bath && nh.bath;
            for (const [id, n] of b) { const extra = n - (a.get(id) || 0); if (extra > 0 && FURN[id] && !(newBath && BATH_ITEMS.has(id))) cost += extra * FURN[id]; }
            for (const [id, n] of a) { const gone = n - (b.get(id) || 0); if (gone > 0 && FURN[id]) credit += gone * Math.round(FURN[id] / 2 / 100) * 100; }
          }
          house = nh;
        }
      } else if (had.house && !nh) notes.push("Houses can't be demolished");
      // bulldozer edits that fall on this plot
      const edits: Edits = {};
      for (const [k, h] of Object.entries(wantEdits)) if (plotOfCell(+k) === key && Number.isInteger(h) && h > -20 && h < 120) edits[k] = h;
      const changed = !sameJSON(house, had.house) || !sameJSON(edits, Object.fromEntries(Object.entries(old.edits).filter(([k]) => plotOfCell(+k) === key))) || !!keep[key];
      if (changed) {
        await c.query("UPDATE plots SET house = $2, edits = $3, updated_at = now() WHERE key = $1 AND owner = $4", [key, house, edits, me.id]);
        news.push({ key, owner: me.id, ownerName: me.name, npc: false, big: !!(PLOTS[key]?.[1] === "b"), house, edits });
      }
    }
    // 4. the bulldozer
    let dozer = old.dozer;
    if (!old.dozer && s.dozer) { dozer = true; if (!importing) cost += DOZER_PRICE; }
    // 5. money: what you had, minus what you bought, plus sales, plus what you could have earned since
    //    and anything other players sent you since (the inbox), which the game doesn't know about yet
    let money: number, corrected = false;
    const inbox = Math.round(w.inbox || 0);
    if (importing) money = Math.max(0, Math.min(Math.round(s.money), START_MONEY)) + inbox;
    else {
      const base = old.money - cost + credit, cap = earnCap(new Date(w.updated_at));
      money = Math.round(s.money) + refund + inbox;
      if (money > base + cap + inbox) { money = Math.round(base + cap + inbox); corrected = true; }
      if (money < 0) { money = 0; corrected = true; }
    }
    const v = await c.query("UPDATE wallets SET money = $2, dozer = $3, inbox = 0, version = version + 1, synced_at = COALESCE(synced_at, now()), updated_at = now() WHERE user_id = $1 RETURNING version", [me.id, money, dozer]);
    const received = await takeReceived(c, me.id);
    await c.query("COMMIT");
    const state = await stateOf(pool, me.id);
    announce(news);
    res.json({ ok: true, version: v.rows[0].version, state, conflicts, corrected, notes, imported: importing, received });
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
});
