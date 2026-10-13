import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

const SECRET = process.env.JWT_SECRET || "";
if (SECRET.length < 32) console.warn("JWT_SECRET is missing or short: set a long random value in .env");

export interface TokenUser { id: string; name: string }

export const signToken = (u: TokenUser) => jwt.sign({ sub: u.id, name: u.name }, SECRET, { expiresIn: "30d" });

export function verifyToken(token: string): TokenUser | null {
  try {
    const p = jwt.verify(token, SECRET) as jwt.JwtPayload;
    return p.sub ? { id: String(p.sub), name: String(p.name || "") } : null;
  } catch {
    return null;
  }
}

// Express middleware: needs "Authorization: Bearer <token>"
export function requireUser(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization || "";
  const u = h.startsWith("Bearer ") ? verifyToken(h.slice(7)) : null;
  if (!u) return res.status(401).json({ error: "Sign in first" });
  (req as Request & { user: TokenUser }).user = u;
  next();
}
