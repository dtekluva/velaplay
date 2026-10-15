import { Room, Client } from "colyseus";
import { Schema, MapSchema, type } from "@colyseus/schema";
import { verifyToken } from "../auth";
import { pool } from "../db";
import { Character } from "../schemas";
import { onPlotNews, onTell } from "../land";
import { TRACKS, LISTS, XF, trackMs } from "../music";
import { startVisit, sampleVisit, saveVisit, live, type Visit } from "../visits";

// what everyone sees of a player: position, facing, animation, vehicle, and their look
export class Player extends Schema {
  @type("string") name = "";
  @type("number") x = 0;
  @type("number") y = 10;
  @type("number") z = 0;
  @type("number") ry = 0;
  @type("string") anim = "idle";
  @type("string") veh = "";
  @type("string") look = "{}";
  @type("boolean") voice = false;   // in voice chat
  @type("boolean") talk = false;    // holding push-to-talk
  @type("string") ride = "";        // riding in another player's vehicle: the driver's session id
  @type("uint8") seat = 0;          // which seat (1 = front passenger, 2-3 behind; a motorbike's pillion is 1)
}
// how many passengers a vehicle takes (besides the driver)
const seatsIn = (veh: string) => !veh || veh === "dozer" ? 0 : veh === "bike" ? 1 : veh === "truck" ? 2 : 3;
// what a club is playing: the track, when it started and when it ends (server ms), where it is in its playlist, a queued request
export class ClubMusic extends Schema {
  @type("string") key = "";
  @type("number") start = 0;
  @type("number") end = 0;
  @type("uint8") i = 0;
  @type("string") req = "";
}
// a house party: whose, where, its playlist (one of the clubs' "vibes") and what it's playing, and when it ends
export class Party extends Schema {
  @type("string") owner = "";   // account id
  @type("string") name = "";
  @type("string") key = "";     // the plot
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  @type("string") vibe = "";    // a club's name: its playlist
  @type("string") track = "";
  @type("number") start = 0;
  @type("number") end = 0;
  @type("uint8") i = 0;
  @type("number") until = 0;
}
export class WorldState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: ClubMusic }) clubs = new MapSchema<ClubMusic>();
  @type({ map: Party }) parties = new MapSchema<Party>();
}

interface Auth { id: string; name: string; guest: boolean; look: string }
const BOUND = 346, WEST = 730, ZLO = -5866,   // WEST: the west edge since Banana Island West (out to x = -744)
  ZHI = 1066, MAX_STEP = 40;   // ZHI: the south edge, out past the Lekki Deep Sea Port at sea;   // the map edge (ZLO: the north edge, out past Yaba, Ikeja, Ibadan and Oyo on the mainland); the most anyone can move between two updates (a fast car or a plane at 20 Hz is far below this)
const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;

export class WorldRoom extends Room<WorldState> {
  maxClients = 100;
  private lastChat = new Map<string, number>();
  private lastWarp = new Map<string, number>();
  private lastLook = new Map<string, number>();
  private stopNews?: () => void;
  private stopTell?: () => void;
  private lastDJ = new Map<string, number>();
  private lastRing = new Map<string, number>();
  private lastRideReq = new Map<string, number>();
  private rideReqs = new Map<string, string>();
  private visits = new Map<string, Visit>();   // the visit log (see visits.ts)   // passenger session -> the driver they asked
  private rings = new Map<string, string>();   // visitor session + key -> the owner's session it went to (only they can answer)

  onCreate() {
    this.setState(new WorldState());
    this.setPatchRate(50);   // send changes 20 times a second
    // land news (someone bought, built, furnished, fenced, levelled or sold) goes to everyone here
    this.stopNews = onPlotNews((news) => this.broadcast("plot", news));
    // offers, payments and sales for one player go only to them
    this.stopTell = onTell((userId, type, data) => { for (const c of this.clients) if ((c as any).userData?.id === userId) c.send(type, data); });

    // club music: every club starts at a different place in its playlist, and the server moves each one along
    Object.entries(LISTS).forEach(([name, list], n) => {
      const c = new ClubMusic(), t = Date.now(); c.i = n % list.length; c.key = list[c.i]; c.start = t; c.end = t + trackMs(c.key);
      this.state.clubs.set(name, c);
    });
    this.clock.setInterval(() => {
      const t = Date.now();
      this.state.clubs.forEach((c, name) => {
        if (t < c.end - XF * 1000) return;
        const list = LISTS[name], start = c.end - XF * 1000;   // the next one starts as this one fades: the clients crossfade
        if (c.req) { c.key = c.req; c.req = ""; } else { c.i = (c.i + 1) % list.length; c.key = list[c.i]; }   // after a request, the playlist carries on where it was
        c.start = start; c.end = start + trackMs(c.key);
      });
      // house parties: the same, and they end at their time
      this.state.parties.forEach((pa, key) => {
        if (t > pa.until) { this.state.parties.delete(key); this.broadcast("partyend", { key, name: pa.name }); return; }
        if (t < pa.end - XF * 1000) return;
        const list = LISTS[pa.vibe], start = pa.end - XF * 1000;
        pa.i = (pa.i + 1) % list.length; pa.track = list[pa.i]; pa.start = start; pa.end = start + trackMs(pa.track);
      });
    }, 250);
    // house parties: the owner of a home starts one (we check they own it), skips songs, or ends it
    this.onMessage("party", async (client, m: any) => {
      const me = this.state.players.get(client.sessionId), uid = (client as any).userData?.id;
      if (!me || !uid || typeof m?.key !== "string" || m.key.length > 40) return;
      const pa = this.state.parties.get(m.key), t = Date.now();
      if (m.action === "start") {
        if (pa || !(m.vibe in LISTS)) return;
        for (const other of this.state.parties.values()) if (other.owner === uid) return;   // one party at a time
        const q = await pool.query("SELECT 1 FROM plots WHERE key = $1 AND owner = $2 AND house IS NOT NULL", [m.key, uid]);
        if (!q.rowCount) return client.send("partyres", { ok: false, why: "That isn't your home" });
        const x = num(m.x, -WEST, BOUND), y = num(m.y, -50, 400), z = num(m.z, ZLO, ZHI); if (x === null || y === null || z === null) return;
        const p = new Party(), list = LISTS[m.vibe];
        Object.assign(p, { owner: uid, name: me.name, key: m.key, x, y, z, vibe: m.vibe, i: 0, track: list[0], start: t, end: t + trackMs(list[0]), until: t + 30 * 60 * 1000 });
        this.state.parties.set(m.key, p);
        this.broadcast("partynews", { key: m.key, name: me.name, x, z, vibe: m.vibe });
      } else if (pa && pa.owner === uid && m.action === "skip") {
        const list = LISTS[pa.vibe]; pa.i = (pa.i + 1) % list.length; pa.track = list[pa.i]; pa.start = t; pa.end = t + trackMs(pa.track);
      } else if (pa && pa.owner === uid && m.action === "end") {
        this.state.parties.delete(m.key); this.broadcast("partyend", { key: m.key, name: pa.name });
      }
    });
    // the clock: each game measures its offset from ours, so they all agree where a track is
    // the visit log: a position sample every 5 s, saved every minute
    this.clock.setInterval(() => this.state.players.forEach((p, id) => { const v = this.visits.get(id); if (v) sampleVisit(id, v, p.x, p.z); }), 5000);
    this.clock.setInterval(() => { for (const v of this.visits.values()) saveVisit(v); }, 60000);
    this.onMessage("clk", (client, m: any) => { const t = Number(m?.t); client.send("clk", { t: Number.isFinite(t) ? t : 0, s: Date.now() }); });   // a ms timestamp arrives as a 64-bit integer (a BigInt)
    // a DJ booth request: play a track next, or now. The tip is the player's own money (their land record syncs it)
    this.onMessage("dj", (client, m: any) => {
      const p = this.state.players.get(client.sessionId), c = typeof m?.club === "string" ? this.state.clubs.get(m.club) : undefined;
      if (!p || !c || typeof m.key !== "string" || !(m.key in TRACKS)) return;
      const t = Date.now(); if (t - (this.lastDJ.get(client.sessionId) || 0) < 4000) return;   // one request every few seconds
      this.lastDJ.set(client.sessionId, t);
      if (m.now) { c.key = m.key; c.req = ""; c.start = t; c.end = t + trackMs(m.key); }
      else {   // next: at the end of this pass of the loop
        const len = TRACKS[c.key] * 1000, passEnd = c.start + Math.ceil((t - c.start + 500) / len) * len;
        c.req = m.key; c.end = Math.max(t + (XF + 1) * 1000, Math.min(c.end, passEnd + XF * 1000));
      }
      this.broadcast("djreq", { club: m.club, key: m.key, now: !!m.now, by: p.name, id: client.sessionId });
    });

    // doorbell visits: a ring goes to the home's owner if they're online; their answer goes back to whoever rang
    this.onMessage("ring", (client, m: any) => {
      const p = this.state.players.get(client.sessionId); if (!p || typeof m?.key !== "string" || typeof m?.owner !== "string" || m.key.length > 40) return;
      const t = Date.now(); if (t - (this.lastRing.get(client.sessionId) || 0) < 6000) return;   // one ring every few seconds
      this.lastRing.set(client.sessionId, t);
      const owner = this.clients.find((c) => (c as any).userData?.id === m.owner);
      if (!owner || owner === client) return client.send("ringres", { key: m.key, ok: false, why: "away" });
      this.rings.set(client.sessionId + "|" + m.key, owner.sessionId);
      owner.send("ring", { key: m.key, from: p.name, id: client.sessionId });
    });
    this.onMessage("answer", (client, m: any) => {
      const me = this.state.players.get(client.sessionId), to = typeof m?.id === "string" ? this.clients.find((c) => c.sessionId === m.id) : undefined;
      if (!me || !to || typeof m.key !== "string") return;
      const k = m.id + "|" + m.key; if (this.rings.get(k) !== client.sessionId) return;   // only the owner the ring went to can answer it
      this.rings.delete(k); to.send("ringres", { key: m.key, ok: !!m.ok, name: me.name });
    });

    // riding together: ask a driver for a ride; they say yes or no; a passenger can hop out; seats run out at 3 (1 on a bike)
    const passengers = (driver: string) => [...this.state.players.values()].filter((q) => q.ride === driver);
    const dropAll = (driver: string) => this.state.players.forEach((q) => { if (q.ride === driver) { q.ride = ""; q.seat = 0; } });
    this.onMessage("ridereq", (client, m: any) => {
      const me = this.state.players.get(client.sessionId), d = typeof m?.to === "string" ? this.state.players.get(m.to) : undefined, to = this.clients.find((c) => c.sessionId === m?.to);
      if (!me || !d || !to || to === client || me.veh || me.ride || !d.veh || d.ride) return;
      const t = Date.now(); if (t - (this.lastRideReq.get(client.sessionId) || 0) < 4000) return;
      this.lastRideReq.set(client.sessionId, t);
      if (Math.hypot(me.x - d.x, me.z - d.z) > 15) return;
      if (passengers(m.to).length >= seatsIn(d.veh)) return client.send("rideres", { ok: false, name: d.name, why: "full" });
      this.rideReqs.set(client.sessionId, m.to);
      to.send("ridereq", { id: client.sessionId, from: me.name });
    });
    this.onMessage("rideans", (client, m: any) => {
      const d = this.state.players.get(client.sessionId), pid = typeof m?.id === "string" ? m.id : "", q = this.state.players.get(pid), qc = this.clients.find((c) => c.sessionId === pid);
      if (!d || !q || !qc || this.rideReqs.get(pid) !== client.sessionId) return;   // only the driver they asked can answer
      this.rideReqs.delete(pid);
      const taken = new Set(passengers(client.sessionId).map((x) => x.seat)), cap = seatsIn(d.veh);
      let seat = 0; for (let k = 1; k <= cap; k++) if (!taken.has(k)) { seat = k; break; }
      if (!m.ok || !seat || q.veh || q.ride) return qc.send("rideres", { ok: false, name: d.name, why: !seat && m.ok ? "full" : "no" });
      q.ride = client.sessionId; q.seat = seat;
      qc.send("rideres", { ok: true, name: d.name });
    });
    this.onMessage("rideleave", (client) => { const q = this.state.players.get(client.sessionId); if (q) { q.ride = ""; q.seat = 0; } });

    this.onMessage("move", (client, m: any) => {
      const p = this.state.players.get(client.sessionId); if (!p || !m) return;
      const x = num(m.x, -WEST, BOUND), y = num(m.y, -50, 400), z = num(m.z, ZLO, ZHI), ry = num(m.ry, -10, 10);
      if (x === null || y === null || z === null || ry === null) return;
      // ignore impossible jumps, except the game's own teleports (respawn, lifts, taxis), at most one every 3 s
      if (Math.hypot(x - p.x, z - p.z) > MAX_STEP && p.anim !== "spawn") {
        const t = Date.now(), last = this.lastWarp.get(client.sessionId) || 0;
        if (!m.warp || t - last < 3000) return;
        this.lastWarp.set(client.sessionId, t);
      }
      p.x = x; p.y = y; p.z = z; p.ry = ry;
      if (typeof m.anim === "string" && m.anim.length <= 16) p.anim = m.anim;
      if (typeof m.veh === "string" && m.veh.length <= 24) { if (p.veh && !m.veh) dropAll(client.sessionId); p.veh = m.veh; }   // the driver got out: everyone out
    });

    // a new look (the character creator, or hat and sunglasses on or off)
    this.onMessage("look", (client, m: any) => {
      const p = this.state.players.get(client.sessionId); if (!p) return;
      const t = Date.now(); if (t - (this.lastLook.get(client.sessionId) || 0) < 500) return;
      const r = Character.safeParse(m); if (!r.success) return;
      this.lastLook.set(client.sessionId, t); p.look = JSON.stringify(r.data);
    });

    // proximity voice: who's in voice and who's talking, and passing WebRTC offers, answers and ICE between two players
    this.onMessage("voice", (client, m: any) => {
      const p = this.state.players.get(client.sessionId); if (!p) return;
      p.voice = !!m?.on; p.talk = !!m?.on && !!m?.talk;
    });
    this.onMessage("rtc", (client, m: any) => {
      if (!m || typeof m.to !== "string" || !m.data || JSON.stringify(m.data).length > 16000) return;
      const to = this.clients.find((c) => c.sessionId === m.to); if (!to) return;
      const a = this.state.players.get(client.sessionId), b = this.state.players.get(m.to);
      if (!a || !b || !a.voice || Math.hypot(a.x - b.x, a.z - b.z) > 60) return;   // only between nearby players who are both in voice
      to.send("rtc", { from: client.sessionId, data: m.data });
    });

    this.onMessage("chat", (client, m: any) => {
      const p = this.state.players.get(client.sessionId); if (!p) return;
      const text = typeof m?.text === "string" ? m.text.replace(/\s+/g, " ").trim().slice(0, 160) : "";
      const now = Date.now(), last = this.lastChat.get(client.sessionId) || 0;
      if (!text || now - last < 1000) return;   // one message a second at most
      this.lastChat.set(client.sessionId, now);
      this.broadcast("chat", { from: p.name, id: client.sessionId, text, x: p.x, z: p.z });
    });
  }

  // sign in with your token, or (while testing) join as a guest with a name
  async onAuth(_client: Client, options: any): Promise<Auth> {
    const u = typeof options?.token === "string" ? verifyToken(options.token) : null;
    if (u) {
      const c = await pool.query("SELECT spec FROM characters WHERE user_id = $1", [u.id]);
      return { id: u.id, name: u.name, guest: false, look: JSON.stringify(c.rows[0]?.spec ?? {}) };
    }
    if (process.env.ALLOW_GUESTS !== "false") {
      const name = typeof options?.name === "string" ? options.name.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, 24) : "";
      return { id: "", name: (name || "Guest") + " (guest)", guest: true, look: "{}" };
    }
    throw new Error("Sign in to join the world");
  }

  onJoin(client: Client, options?: any, authData?: Auth) {
    const auth = authData as Auth;
    // one session per account: a second login replaces the first
    if (!auth.guest) for (const c of this.clients) if (c !== client && (c as any).userData?.id === auth.id) c.leave(4000);
    client.userData = { id: auth.id };
    const p = new Player();
    p.name = auth.name; p.look = auth.look; p.anim = "spawn";
    // start where the player already is in their game (clamped to the map), else by the pyramid
    const ox = num(options?.x, -WEST, BOUND), oy = num(options?.y, -50, 400), oz = num(options?.z, ZLO, ZHI);
    p.x = ox ?? (Math.random() - .5) * 6; p.z = oz ?? (Math.random() - .5) * 6; p.y = oy ?? 10;
    if (auth.guest && options?.look) { const r = Character.safeParse(options.look); if (r.success) p.look = JSON.stringify(r.data); }
    this.state.players.set(client.sessionId, p);
    const device = options?.device === "phone" ? "phone" : "desktop";
    this.visits.set(client.sessionId, startVisit(client.sessionId, auth.guest ? null : auth.id, auth.name, device, p.x, p.z));
    setTimeout(() => { if (p.anim === "spawn") p.anim = "idle"; }, 3000);
    console.log(`${auth.name} joined (${this.clients.length} in the world)`);
  }

  onDispose() { this.stopNews?.(); this.stopTell?.(); for (const [id, v] of this.visits) { saveVisit(v, true); live.delete(id); } }

  onLeave(client: Client) {
    const v = this.visits.get(client.sessionId); if (v) { saveVisit(v, true); this.visits.delete(client.sessionId); } live.delete(client.sessionId);
    this.state.players.forEach((q) => { if (q.ride === client.sessionId) { q.ride = ""; q.seat = 0; } });   // the driver's gone: passengers are dropped
    this.rideReqs.delete(client.sessionId); this.lastRideReq.delete(client.sessionId);
    const uid = (client as any).userData?.id;   // the host leaving ends their party
    if (uid) this.state.parties.forEach((pa, key) => { if (pa.owner === uid) { this.state.parties.delete(key); this.broadcast("partyend", { key, name: pa.name }); } });
    this.state.players.delete(client.sessionId);
    this.lastChat.delete(client.sessionId); this.lastWarp.delete(client.sessionId); this.lastLook.delete(client.sessionId); this.lastDJ.delete(client.sessionId); this.lastRing.delete(client.sessionId); for (const k of [...this.rings.keys()]) if (k.startsWith(client.sessionId + "|")) this.rings.delete(k);
  }
}
