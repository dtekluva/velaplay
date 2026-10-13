import { Room, Client } from "colyseus";
import { Schema, MapSchema, type } from "@colyseus/schema";
import { verifyToken } from "../auth";
import { pool } from "../db";

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
}
export class WorldState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}

interface Auth { id: string; name: string; guest: boolean; look: string }
const BOUND = 346, MAX_STEP = 40;   // the map edge; the most anyone can move between two updates (a fast car or a plane at 20 Hz is far below this)
const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;

export class WorldRoom extends Room<WorldState> {
  maxClients = 100;
  private lastChat = new Map<string, number>();

  onCreate() {
    this.setState(new WorldState());
    this.setPatchRate(50);   // send changes 20 times a second

    this.onMessage("move", (client, m: any) => {
      const p = this.state.players.get(client.sessionId); if (!p || !m) return;
      const x = num(m.x, -BOUND, BOUND), y = num(m.y, -50, 400), z = num(m.z, -BOUND, BOUND), ry = num(m.ry, -10, 10);
      if (x === null || y === null || z === null || ry === null) return;
      if (Math.hypot(x - p.x, z - p.z) > MAX_STEP && p.anim !== "spawn") return;   // ignore teleports
      p.x = x; p.y = y; p.z = z; p.ry = ry;
      if (typeof m.anim === "string" && m.anim.length <= 16) p.anim = m.anim;
      if (typeof m.veh === "string" && m.veh.length <= 24) p.veh = m.veh;
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

  onJoin(client: Client, _options?: any, authData?: Auth) {
    const auth = authData as Auth;
    // one session per account: a second login replaces the first
    if (!auth.guest) for (const c of this.clients) if (c !== client && (c as any).userData?.id === auth.id) c.leave(4000);
    client.userData = { id: auth.id };
    const p = new Player();
    p.name = auth.name; p.look = auth.look; p.anim = "spawn";
    p.x = (Math.random() - .5) * 6; p.z = (Math.random() - .5) * 6; p.y = 10;
    this.state.players.set(client.sessionId, p);
    setTimeout(() => { if (p.anim === "spawn") p.anim = "idle"; }, 3000);
    console.log(`${auth.name} joined (${this.clients.length} in the world)`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.lastChat.delete(client.sessionId);
  }
}
