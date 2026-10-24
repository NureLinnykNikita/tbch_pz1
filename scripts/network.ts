import { spawn } from "node:child_process";

const ports = [3001, 3002, 3003];
const children = ports.map((port) =>
  spawn(process.execPath, ["src/server.ts"], {
    env: { ...process.env, PORT: String(port) },
    stdio: "inherit",
  }),
);
function stop(): void {
  children.forEach((c) => c.kill("SIGTERM"));
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  for (const port of ports) {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error(`Node ${port} did not start`);
    for (const other of ports.filter((p) => p !== port)) {
      await fetch(`http://127.0.0.1:${port}/peers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${other}` }),
      });
    }
  }
  for (const port of ports)
    await fetch(`http://127.0.0.1:${port}/sync`, { method: "POST" });
  console.log(
    "Three nodes connected: http://127.0.0.1:3001, :3002, :3003. Ctrl+C stops all nodes.",
  );
} catch (e) {
  stop();
  throw e;
}
