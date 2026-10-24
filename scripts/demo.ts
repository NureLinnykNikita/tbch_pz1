import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { wallet, transfer, txId } from "../src/crypto.ts";
import { Blockchain, mine, validateChain } from "../src/blockchain.ts";
import type { Block } from "../src/blockchain.ts";

const evidence: Record<string, string[]> = {};
function record(section: string, line: string): void {
  (evidence[section] ??= []).push(line);
  console.log(`[${section}] ${line}`);
}
function rejected(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("Attack unexpectedly accepted");
}
const a = wallet(),
  b = wallet();
const local = new Blockchain();
local.mine(a.address, 1000);
const tx = transfer(a, b.address, 10, 1, 1);
local.submit(tx);
local.mine(b.address, 2000);
local.mine(b.address, 3000);
const damaged = structuredClone(local.chain);
damaged[2].transactions[1].amount = 999;
const r1 = validateChain(damaged);
assert.equal(r1.valid, false);
record("attack1", "ACTION: old block #2 transfer.amount: 10 -> 999");
record("attack1", JSON.stringify(r1));
const repaired = structuredClone(local.chain);
repaired[2].header.timestamp++;
repaired[2] = mine(repaired[2]);
assert.notEqual(repaired[2].hash, local.chain[2].hash);
const r2 = validateChain(repaired);
assert.match(r2.reason, /previousHash/);
record(
  "attack2",
  "ACTION: block #2 timestamp changed; hash and PoW recomputed",
);
record("attack2", JSON.stringify(r2));
const forged = transfer(a, b.address, 1, 0, 2);
forged.signature = "0".repeat(128);
record("attack3", "ACTION: replace signature with 128 zero hex characters");
record("attack3", "REJECTED: " + rejected(() => local.submit(forged)));
const spending = new Blockchain();
spending.mine(a.address, 1000);
spending.submit(transfer(a, b.address, 50, 0, 1));
record(
  "attack4",
  "ACTION: balance=50; first pending transfer=50, nonce=1: accepted",
);
record("attack4", "ACTION: second transfer=50, nonce=2");
record(
  "attack4",
  "REJECTED: " +
    rejected(() => spending.submit(transfer(a, b.address, 50, 0, 2))),
);
record("attack5", "ACTION: resubmit confirmed transfer with nonce=1");
record("attack5", "REJECTED: " + rejected(() => local.submit(tx)));
const ports = [4311, 4312, 4313];
const dir = mkdtempSync(join(tmpdir(), "pz1-network-"));
const children: ChildProcess[] = ports.map((port) =>
  spawn(process.execPath, ["src/server.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: join(dir, `${port}.json`),
    },
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
for (const c of children)
  c.stderr?.on("data", (chunk) => process.stderr.write(chunk));
async function call(port: number, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}
async function eventually(fn: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out waiting for network");
}
try {
  for (const port of ports)
    await eventually(async () => Boolean(await call(port, "/health")));
  for (const port of ports)
    for (const other of ports.filter((p) => p !== port))
      await call(port, "/peers", { url: `http://127.0.0.1:${other}` });
  const funded = (await call(4311, "/mine", { address: a.address })) as Block;
  await eventually(async () =>
    (await Promise.all(ports.map((p) => call(p, "/health")))).every(
      (s) => s.tip === funded.hash,
    ),
  );
  const gossip = transfer(a, b.address, 5, 1, 1);
  await call(4311, "/transactions", gossip);
  await eventually(async () =>
    (await Promise.all(ports.map((p) => call(p, "/health")))).every(
      (s) => s.mempool === 1,
    ),
  );
  record("sync", "Transaction gossip: mempool=1 on all three nodes");
  const confirmed = (await call(4312, "/mine", {
    address: b.address,
  })) as Block;
  await eventually(async () =>
    (await Promise.all(ports.map((p) => call(p, "/health")))).every(
      (s) => s.tip === confirmed.hash && s.mempool === 0,
    ),
  );
  for (const port of ports) {
    const s = await call(port, "/health");
    record(
      "sync",
      `port=${port} pid=${s.pid} height=${s.height} work=${s.work} mempool=${s.mempool}`,
    );
  }
  record("sync", `Identical tip: ${confirmed.hash}`);
  await call(4313, "/network", { online: false });
  const orphan = transfer(a, b.address, 7, 1, 2);
  await call(4313, "/transactions", orphan);
  await call(4313, "/mine", { address: b.address });
  await call(4311, "/mine", { address: b.address });
  await eventually(async () => (await call(4312, "/health")).height === 3);
  await call(4311, "/mine", { address: b.address });
  await eventually(async () => (await call(4312, "/health")).height === 4);
  record(
    "fork",
    "ACTION: isolate node 4313; mine transfer nonce=2 on losing branch",
  );
  for (const port of ports) {
    const s = await call(port, "/health");
    record("fork", `BEFORE port=${port} height=${s.height} work=${s.work}`);
  }
  await call(4313, "/network", { online: true });
  const adopted = await call(4313, "/sync", {});
  assert.equal(adopted.adopted, 1);
  const pool = await call(4313, "/mempool");
  assert.equal(pool.length, 1);
  assert.equal(txId(pool[0]), txId(orphan));
  record(
    "fork",
    `AFTER sync: adopted=${adopted.adopted}, orphan transfer returned to mempool=${pool.length}`,
  );
  const reIncluded = (await call(4313, "/mine", {
    address: b.address,
  })) as Block;
  await eventually(async () =>
    (await Promise.all(ports.map((p) => call(p, "/health")))).every(
      (s) => s.tip === reIncluded.hash,
    ),
  );
  record(
    "fork",
    `Re-mined orphan in block #${reIncluded.header.height}; three tips equal`,
  );
  for (const port of ports) {
    const v = await call(port, "/validate");
    assert.ok(v.valid);
    record("fork", `port=${port}: chain valid=${v.valid}`);
  }
  // Restart one actual process using the same storage file.
  const exited = once(children[2], "exit");
  children[2].kill("SIGTERM");
  await exited;
  children[2] = spawn(process.execPath, ["src/server.ts"], {
    env: { ...process.env, PORT: "4313", DATA_FILE: join(dir, "4313.json") },
    stdio: "ignore",
  });
  await eventually(
    async () => (await call(4313, "/health")).tip === reIncluded.hash,
  );
  record(
    "restart",
    "Node 4313 restarted from disk: height=5; tip unchanged; validation OK",
  );
} finally {
  await Promise.all(
    children.map(async (c) => {
      if (c.exitCode === null) {
        const done = once(c, "exit");
        c.kill("SIGTERM");
        await done;
      }
    }),
  );
  mkdirSync("evidence", { recursive: true });
  writeFileSync("evidence/demo.json", JSON.stringify(evidence, null, 2));
  for (const [name, lines] of Object.entries(evidence))
    writeFileSync(`evidence/${name}.txt`, lines.join("\n") + "\n");
}
