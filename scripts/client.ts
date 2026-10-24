import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { wallet, transfer } from "../src/crypto.ts";

const [command, ...args] = process.argv.slice(2);
if (command === "wallet") {
  const file = args[0] ?? "wallets/alice.json";
  const w = wallet();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(w, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ address: w.address, file }));
} else if (command === "send") {
  const [file, to, amount, fee = "0", node = "http://127.0.0.1:3001"] = args;
  const w = JSON.parse(readFileSync(file, "utf8"));
  const state = (await (
    await fetch(`${node}/balance?address=${w.address}`)
  ).json()) as { nonce: number };
  const pending = (await (await fetch(`${node}/mempool`)).json()) as {
    from: string;
    nonce: number;
  }[];
  const nonce =
    Math.max(
      state.nonce,
      ...pending.filter((t) => t.from === w.address).map((t) => t.nonce),
    ) + 1;
  const tx = transfer(w, to, Number(amount), Number(fee), nonce);
  const response = await fetch(node + "/transactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tx),
  });
  console.log(response.status, await response.text());
  if (!response.ok) process.exitCode = 1;
} else {
  console.log(
    "node scripts/client.ts wallet [wallets/alice.json]\nnode scripts/client.ts send FILE TO AMOUNT [FEE] [NODE_URL]",
  );
}
