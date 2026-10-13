import { Router, type Request } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "./db";
import { signToken, requireUser, type TokenUser } from "./auth";
import { Character } from "./schemas";

export const api = Router();
const userOf = (req: Request) => (req as Request & { user: TokenUser }).user;

api.get("/health", async (_req, res) => {
  const db = await pool.query("SELECT 1").then(() => true).catch(() => false);
  res.json({ ok: true, db, time: new Date().toISOString() });
});

const Register = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(2).max(24).regex(/^[\p{L}\p{N} _.'-]+$/u, "Letters, numbers, spaces and _ . ' - only"),
});
api.post("/auth/register", async (req, res) => {
  const r = Register.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: r.error.issues[0]?.message || "Invalid details" });
  const { email, password, name } = r.data;
  const hash = await bcrypt.hash(password, 11);
  try {
    const q = await pool.query("INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, display_name", [email, hash, name]);
    const u = { id: q.rows[0].id, name: q.rows[0].display_name };
    await pool.query("INSERT INTO characters (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [u.id]);
    res.status(201).json({ token: signToken(u), user: u });
  } catch (e: any) {
    if (e.code === "23505") return res.status(409).json({ error: e.constraint?.includes("display_name") ? "That name is taken" : "That email already has an account" });
    throw e;
  }
});

const Login = z.object({ email: z.string().email(), password: z.string().min(1) });
api.post("/auth/login", async (req, res) => {
  const r = Login.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: "Email and password, please" });
  const q = await pool.query("SELECT id, display_name, password_hash FROM users WHERE lower(email) = lower($1)", [r.data.email]);
  const row = q.rows[0];
  if (!row || !(await bcrypt.compare(r.data.password, row.password_hash))) return res.status(401).json({ error: "Wrong email or password" });
  const u = { id: row.id, name: row.display_name };
  res.json({ token: signToken(u), user: u });
});

api.get("/me", requireUser, async (req, res) => {
  const u = userOf(req);
  const c = await pool.query("SELECT spec FROM characters WHERE user_id = $1", [u.id]);
  res.json({ user: u, character: c.rows[0]?.spec ?? {} });
});

// your scout's look: only known fields, only sensible values (see schemas.ts)
api.put("/character", requireUser, async (req, res) => {
  const r = Character.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: r.error.issues[0]?.message || "Invalid character" });
  await pool.query("INSERT INTO characters (user_id, spec, updated_at) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET spec = $2, updated_at = now()", [userOf(req).id, r.data]);
  res.json({ ok: true, character: r.data });
});

// cloud save: the game's land/homes/furniture/money record. For now it is stored as the player sends it;
// once ownership is shared between players, the server takes over buying, building and money (stage 4).
api.get("/save", requireUser, async (req, res) => {
  const q = await pool.query("SELECT data, version, updated_at FROM saves WHERE user_id = $1", [userOf(req).id]);
  res.json(q.rows[0] ?? { data: null, version: 0 });
});
api.put("/save", requireUser, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "Save must be an object" });
  if (JSON.stringify(body).length > 512 * 1024) return res.status(413).json({ error: "Save too large" });
  const q = await pool.query(
    "INSERT INTO saves (user_id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET data = $2, version = saves.version + 1, updated_at = now() RETURNING version",
    [userOf(req).id, body]);
  res.json({ ok: true, version: q.rows[0].version });
});
