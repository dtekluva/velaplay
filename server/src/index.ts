import http from "http";
import path from "path";
import express from "express";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { migrate } from "./db";
import { api } from "./api";
import { land } from "./land";
import { WorldRoom } from "./rooms/WorldRoom";

async function main() {
  await migrate();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "600kb" }));
  app.use((req, res, next) => {   // the game client may be served from elsewhere (Netlify, the artifact) while we build
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.use("/api", api);
  app.use("/api", land);
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  });

  const server = http.createServer(app);
  const game = new Server({ transport: new WebSocketTransport({ server }) });
  game.define("world", WorldRoom);
  const port = Number(process.env.PORT || 2567);
  server.listen(port, () => console.log(`VelaPlay server on :${port}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
