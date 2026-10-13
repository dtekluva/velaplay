import { Pool, Client } from "pg";
import fs from "fs";
import path from "path";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// apply any .sql files in migrations/ that haven't run yet, in name order, each in one transaction.
// Hidden files are skipped: macOS archives add "._name.sql" metadata files that are not SQL.
export async function migrate(): Promise<void> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const dir = path.join(__dirname, "migrations");
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.startsWith(".")).sort()) {
      if (done.has(name)) continue;
      await c.query(`BEGIN; ${fs.readFileSync(path.join(dir, name), "utf8")}; INSERT INTO schema_migrations (name) VALUES ('${name.replace(/'/g, "''")}'); COMMIT;`).catch(async (e) => { await c.query("ROLLBACK").catch(() => {}); throw e; });
      console.log(`migration applied: ${name}`);
    }
  } finally {
    await c.end();
  }
}
