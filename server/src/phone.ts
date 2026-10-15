import { Router, type Request, type Response, type NextFunction } from "express";
import { pool } from "./db";
import { requireUser, type TokenUser } from "./auth";

/* The phone's server side: your texts (accounts keep a history; a text to an account that's away waits for them), and the
   bank's statement (money players sent you or you sent them, land bought and sold). Texts themselves travel through the
   world room (WorldRoom "sms"), which stores them here. */
export const phone = Router();
const userOf = (req: Request) => (req as Request & { user: TokenUser }).user;
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export async function storeText(sender: string | null, senderName: string, recipient: string, body: string, read: boolean) {
  await pool.query("INSERT INTO messages (sender, sender_name, recipient, body, read) VALUES ($1, $2, $3, $4, $5)", [sender, senderName, recipient, body, read]);
}
export async function userByName(name: string) {
  return (await pool.query("SELECT id, display_name AS name FROM users WHERE lower(display_name) = lower($1)", [name.trim()])).rows[0] as { id: string; name: string } | undefined;
}
// your last 200 texts both ways, newest last
phone.get("/phone/messages", requireUser, wrap(async (req, res) => {
  const me = userOf(req);
  const q = await pool.query(`SELECT m.id, m.sender_name AS from_name, r.display_name AS to_name, m.sender = $1 AS mine, m.body, m.read, m.created_at FROM messages m
    JOIN users r ON r.id = m.recipient WHERE m.recipient = $1 OR m.sender = $1 ORDER BY m.created_at DESC LIMIT 200`, [me.id]);
  res.json({ messages: q.rows.reverse().map((r) => ({ id: +r.id, from: r.from_name, to: r.to_name, mine: r.mine, text: r.body, read: r.read || r.mine, at: +new Date(r.created_at) })) });
}));
phone.post("/phone/read", requireUser, wrap(async (req, res) => {
  const me = userOf(req), from = String(req.body?.from || "");
  await pool.query("UPDATE messages SET read = true WHERE recipient = $1 AND lower(sender_name) = lower($2)", [me.id, from]);
  res.json({ ok: true });
}));
// the statement: the last 40 payments in or out
phone.get("/phone/bank", requireUser, wrap(async (req, res) => {
  const me = userOf(req);
  const q = await pool.query(`SELECT p.amount::float8 AS amount, p.kind, p.ref, p.created_at, p.payer = $1 AS out, a.display_name AS payer, b.display_name AS payee FROM payments p
    LEFT JOIN users a ON a.id = p.payer LEFT JOIN users b ON b.id = p.payee WHERE (p.payer = $1 OR p.payee = $1) AND p.kind <> 'giveaway' ORDER BY p.created_at DESC LIMIT 40`, [me.id]);
  res.json({ rows: q.rows.map((r) => ({ amount: Math.round(r.amount), kind: r.kind, ref: r.ref, at: +new Date(r.created_at), out: r.out, who: r.out ? r.payee : r.payer })) });
}));
