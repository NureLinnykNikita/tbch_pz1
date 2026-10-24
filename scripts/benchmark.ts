import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { genesis, makeBlock, mine } from "../src/blockchain.ts";

const runs = Number(process.env.RUNS ?? 20);
if (!Number.isInteger(runs) || runs < 10)
  throw new Error("At least 10 runs required");
mkdirSync("evidence", { recursive: true });
const rows: {
  difficulty: number;
  run: number;
  elapsedMs: number;
  attempts: number;
}[] = [];
// Warm up SHA-256 and canonical serialization before measured runs.
for (let i = 0; i < 10; i++) mine(makeBlock(genesis(), [], 2, 100 + i));
for (let difficulty = 1; difficulty <= 4; difficulty++) {
  for (let run = 1; run <= runs; run++) {
    const b = makeBlock(genesis(), [], difficulty, 100000 * difficulty + run);
    const start = performance.now();
    const found = mine(b);
    const elapsedMs = performance.now() - start;
    rows.push({ difficulty, run, elapsedMs, attempts: found.header.nonce + 1 });
  }
  const values = rows
    .filter((r) => r.difficulty === difficulty)
    .map((r) => r.elapsedMs);
  const mean = values.reduce((a, b) => a + b) / runs;
  console.log(
    `difficulty=${difficulty} runs=${runs} mean=${mean.toFixed(3)} ms min=${Math.min(...values).toFixed(3)} max=${Math.max(...values).toFixed(3)}`,
  );
}
writeFileSync(
  "evidence/benchmark.json",
  JSON.stringify(
    {
      node: process.version,
      cpu: cpus()[0].model,
      platform: platform(),
      arch: arch(),
      runs,
      rows,
    },
    null,
    2,
  ),
);
writeFileSync(
  "evidence/benchmark.csv",
  "difficulty,run,elapsedMs,attempts\n" +
    rows
      .map((r) => `${r.difficulty},${r.run},${r.elapsedMs},${r.attempts}`)
      .join("\n") +
    "\n",
);
