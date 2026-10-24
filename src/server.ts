import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Blockchain, totalWork, validateChain } from "./blockchain.ts";
import type { Block } from "./blockchain.ts";
import { wallet } from "./crypto.ts";

const port = Number(process.env.PORT ?? 3001);
const file = resolve(process.env.DATA_FILE ?? `data/node-${port}.json`);
const bc = existsSync(file) ? Blockchain.load(file) : new Blockchain();
const peers = new Set<string>();
let online = true;

async function request(
  peer: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const response = await fetch(peer + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function broadcast(path: string, body: unknown): Promise<void> {
  if (online)
    await Promise.allSettled(
      [...peers].map((peer) => request(peer, path, body)),
    );
}

async function sync(): Promise<{ adopted: number; errors: string[] }> {
  let adopted = 0;
  const errors: string[] = [];
  if (!online) throw new Error("Node is disconnected");
  for (const peer of peers) {
    try {
      const data = await request(peer, "/chain");
      if (bc.adopt(data.chain)) {
        bc.save(file);
        adopted++;
      }
    } catch (e) {
      errors.push(`${peer}: ${(e as Error).message}`);
    }
  }
  return { adopted, errors };
}

const server = createServer(async (req, res) => {
  const reply = (status: number, data: unknown): void => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(data));
  };
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    let raw = "";
    for await (const chunk of req) {
      raw += chunk.toString();
      if (Buffer.byteLength(raw) > 2_000_000)
        throw new Error("Request too large");
    }
    const body = raw ? JSON.parse(raw) : {};
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /health")
      return reply(200, {
        port,
        pid: process.pid,
        online,
        height: bc.chain.length - 1,
        tip: bc.chain.at(-1)!.hash,
        work: totalWork(bc.chain).toString(),
        mempool: bc.mempool.length,
      });
    if (route === "POST /wallet") return reply(201, wallet());
    if (route === "GET /chain")
      return reply(200, {
        chain: bc.chain,
        work: totalWork(bc.chain).toString(),
      });
    if (route === "GET /mempool") return reply(200, bc.mempool);
    if (route === "GET /balance") {
      const addr = url.searchParams.get("address") ?? "";
      return reply(200, {
        address: addr,
        balance: bc.balance(addr),
        nonce: bc.nonce(addr),
      });
    }
    if (route === "GET /validate") return reply(200, validateChain(bc.chain));
    if (route === "GET /peers") return reply(200, [...peers]);
    if (route === "POST /peers") {
      const peer = new URL(body.url);
      if (
        peer.protocol !== "http:" ||
        peer.hostname !== "127.0.0.1" ||
        !peer.port
      )
        throw new Error("Use a local HTTP peer at 127.0.0.1");
      if (peer.origin !== `http://127.0.0.1:${port}`) peers.add(peer.origin);
      return reply(200, [...peers]);
    }
    if (route === "POST /network") {
      if (typeof body.online !== "boolean")
        throw new Error("online must be boolean");
      online = body.online;
      return reply(200, { online });
    }
    if (
      route === "POST /transactions" ||
      route === "POST /gossip/transaction"
    ) {
      if (route.includes("/gossip/") && !online)
        return reply(503, { error: "Node is disconnected" });
      const id = bc.submit(body);
      bc.save(file);
      reply(201, { accepted: true, id });
      void broadcast("/gossip/transaction", body);
      return;
    }
    if (route === "POST /mine") {
      const block = bc.mine(body.address);
      bc.save(file);
      reply(201, block);
      void broadcast("/gossip/block", block);
      return;
    }
    if (route === "POST /gossip/block") {
      if (!online) return reply(503, { error: "Node is disconnected" });
      if (bc.chain.some((b) => b.hash === body.hash))
        return reply(200, { duplicate: true });
      const block = body as Block;
      if (block.header?.previousHash === bc.chain.at(-1)!.hash) {
        bc.append(block);
        bc.save(file);
        reply(201, { accepted: true });
        void broadcast("/gossip/block", block);
        return;
      }
      // A foreign tip is not trusted; fetch and validate the entire peer chain.
      return reply(200, await sync());
    }
    if (route === "POST /sync") return reply(200, await sync());
    reply(404, { error: "Unknown endpoint" });
  } catch (e) {
    reply(400, { error: (e as Error).message });
  }
});

server.listen(port, "127.0.0.1", () =>
  console.log(`Node ${port} PID ${process.pid} ready; storage ${file}`),
);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
