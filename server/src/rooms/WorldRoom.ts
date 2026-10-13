import { Room, Client } from "colyseus";
import { Schema, MapSchema, type } from "@colyseus/schema";
import { verifyToken } from "../auth";
import { pool } from "../db";
import { Character } from "../schemas";
import { onPlotNews } from "../land";

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
}
export class WorldState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}

interface Auth { id: string; name: string; guest: boolean; look: string }
const BOUND = 346, ZLO = -730, MAX_STEP = 40;   // the map edge (ZLO: the north edge, out past Yaba on the mainland); the most anyone can move between two updates (a fast car or a plane at 20 Hz is far below this)
const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;

export class WorldRoom extends Room<WorldState> {
  maxClients = 100;
  private lastChat = new Map<string, number>();
  private lastWarp = new Map<string, number>();
  private lastLook = new Map<string, number>();
  private stopNews?: () => void;

  onCreate() {
    this.setState(new WorldState());
    this.setPatchRate(50);   // send changes 20 times a second
    // land news (someone bought, built, furnished, fenced, levelled or sold) goes to everyone here
    this.stopNews = onPlotNews((news) => this.broadcast("plot", news));

    this.onMessage("move", (client, m: any) => {
      const p = this.state.players.get(client.sessionId); if (!p || !m) return;
      const x = num(m.x, -BOUND, BOUND), y = num(m.y, -50, 400), z = num(m.z, ZLO, BOUND), ry = num(m.ry, -10, 10);
      if (x === null || y === null || z === null || ry === null) return;
      // ignore impossible jumps, except the game's own teleports (respawn, lifts, taxis), at most one every 3 s
      if (Math.hypot(x - p.x, z - p.z) > MAX_STEP && p.anim !== "spawn") {
        const t = Date.now(), last = this.lastWarp.get(client.sessionId) || 0;
        if (!m.warp || t - last < 3000) return;
        this.lastWarp.set(client.sessionId, t);
      }
      p.x = x; p.y = y; p.z = z; p.ry = ry;
      if (typeof m.anim === "string" && m.anim.length <= 16) p.anim = m.anim;
      if (typeof m.veh === "string" && m.veh.length <= 24) p.veh = m.veh;
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
    const ox = num(options?.x, -BOUND, BOUND), oy = num(options?.y, -50, 400), oz = num(options?.z, ZLO, BOUND);
    p.x = ox ?? (Math.random() - .5) * 6; p.z = oz ?? (Math.random() - .5) * 6; p.y = oy ?? 10;
    if (auth.guest && options?.look) { const r = Character.safeParse(options.look); if (r.success) p.look = JSON.stringify(r.data); }
    this.state.players.set(client.sessionId, p);
    setTimeout(() => { if (p.anim === "spawn") p.anim = "idle"; }, 3000);
    console.log(`${auth.name} joined (${this.clients.length} in the world)`);
  }

  onDispose() { this.stopNews?.(); }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.lastChat.delete(client.sessionId); this.lastWarp.delete(client.sessionId); this.lastLook.delete(client.sessionId);
  }
}
