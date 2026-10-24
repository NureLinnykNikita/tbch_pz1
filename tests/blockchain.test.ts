import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Blockchain,
  genesis,
  blockHash,
  mine,
  validateChain,
  expectedDifficulty,
  totalWork,
} from "../src/blockchain.ts";
import {
  canonical,
  wallet,
  transfer,
  checkSignature,
  txId,
  hash,
} from "../src/crypto.ts";
import { merkleRoot } from "../src/merkle.ts";
function setup() {
  const a = wallet(),
    b = wallet(),
    chain = new Blockchain();
  chain.mine(a.address, 1000);
  return { a, b, chain };
}
function remine(b: ReturnType<typeof genesis>) {
  b.header.merkleRoot = merkleRoot(b.transactions.map(txId));
  b.header.nonce = 0;
  return mine(b);
}
test("canonical recursively sorts keys and preserves arrays", () => {
  assert.equal(
    canonical({ z: [{ b: 2, a: 1 }], a: 0 }),
    canonical({ a: 0, z: [{ a: 1, b: 2 }] }),
  );
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  assert.throws(() => canonical(NaN));
});
test("Ed25519 signs canonical payload and rejects changed amount", () => {
  const a = wallet(),
    b = wallet();
  const t = transfer(a, b.address, 1, 0, 1);
  assert.ok(checkSignature(t));
  t.amount++;
  assert.ok(!checkSignature(t));
});
test("Merkle even leaves combine binary hashes", () => {
  const a = hash("a"),
    b = hash("b");
  assert.equal(merkleRoot([a, b]), hash(Buffer.from(a + b, "hex")));
});
test("Merkle odd leaves duplicate last hash at each level", () => {
  const a = hash("a"),
    b = hash("b"),
    c = hash("c");
  const left = hash(Buffer.from(a + b, "hex")),
    right = hash(Buffer.from(c + c, "hex"));
  assert.equal(merkleRoot([a, b, c]), hash(Buffer.from(left + right, "hex")));
});
test("genesis is deterministic and validated exactly", () => {
  assert.deepEqual(genesis(), genesis());
  const g = genesis();
  g.header.timestamp++;
  assert.throws(() => new Blockchain([g]), /genesis/);
});
test("PoW finds required prefix", () => {
  const { a, chain } = setup();
  const b = chain.candidate(a.address, 2000);
  b.header.difficulty = 2;
  const found = mine(b);
  assert.ok(found.hash.startsWith("00"));
  assert.equal(found.hash, blockHash(found.header));
});
test("mempool rejects forged signature", () => {
  const { a, b, chain } = setup();
  const t = transfer(a, b.address, 10, 0, 1);
  t.signature = "0".repeat(128);
  assert.throws(() => chain.submit(t), /signature/);
});
test("mempool reserves balance and prevents double spending", () => {
  const { a, b, chain } = setup();
  chain.submit(transfer(a, b.address, 50, 0, 1));
  assert.throws(
    () => chain.submit(transfer(a, b.address, 50, 0, 2)),
    /balance/,
  );
});
test("mempool rejects nonce gaps and duplicate transfers", () => {
  const { a, b, chain } = setup();
  assert.throws(() => chain.submit(transfer(a, b.address, 1, 0, 2)), /nonce/);
  const t = transfer(a, b.address, 1, 0, 1);
  chain.submit(t);
  assert.throws(() => chain.submit(t), /Duplicate/);
});
test("confirmed replay rejected by nonce", () => {
  const { a, b, chain } = setup();
  const t = transfer(a, b.address, 10, 0, 1);
  chain.submit(t);
  chain.mine(b.address, 2000);
  assert.throws(() => chain.submit(t), /nonce/);
});
test("reward includes fees and preserves monetary accounting", () => {
  const { a, b, chain } = setup();
  chain.submit(transfer(a, b.address, 10, 2, 1));
  chain.mine(b.address, 2000);
  assert.equal(chain.balance(a.address), 38);
  assert.equal(chain.balance(b.address), 62);
  assert.equal(chain.balance(a.address) + chain.balance(b.address), 100);
});
test("old transaction mutation detected", () => {
  const { a, b, chain } = setup();
  chain.submit(transfer(a, b.address, 10, 0, 1));
  chain.mine(b.address, 2000);
  const copy = structuredClone(chain.chain);
  copy[2].transactions[1].amount++;
  assert.match(validateChain(copy).reason, /Merkle/);
});
test("remining changed parent breaks child link", () => {
  const { a, chain } = setup();
  chain.mine(a.address, 2000);
  const copy = structuredClone(chain.chain);
  copy[1].header.timestamp++;
  copy[1] = remine(copy[1]);
  assert.match(validateChain(copy).reason, /previousHash/);
});
test("full validation rejects reward inflation even with valid PoW", () => {
  const { chain } = setup();
  const copy = structuredClone(chain.chain);
  copy[1].transactions[0].amount++;
  copy[1] = remine(copy[1]);
  assert.match(validateChain(copy).reason, /reward/);
});
test("full validation rejects overspending and wrong nonce", () => {
  const { a, b, chain } = setup();
  const base = chain.candidate(b.address, 2000);
  for (const t of [
    transfer(a, b.address, 51, 0, 1),
    transfer(a, b.address, 1, 0, 2),
  ]) {
    const block = structuredClone(base);
    block.transactions.push(t);
    assert.equal(validateChain([...chain.chain, remine(block)]).valid, false);
  }
});
test("full validation rejects invalid PoW and false difficulty", () => {
  const { chain } = setup();
  const copy = structuredClone(chain.chain);
  do {
    copy[1].header.nonce++;
    copy[1].hash = blockHash(copy[1].header);
  } while (copy[1].hash.startsWith("0"));
  assert.match(validateChain(copy).reason, /Proof/);
  copy[1].header.difficulty = 2;
  copy[1] = remine(copy[1]);
  assert.match(validateChain(copy).reason, /difficulty/);
});
test("difficulty retarget increases, stays and decreases at K blocks", () => {
  const a = wallet();
  for (const [interval, want] of [
    [100, 2],
    [1000, 1],
    [3000, 1],
  ]) {
    const c = new Blockchain();
    for (let i = 1; i <= 5; i++) c.mine(a.address, i * interval);
    assert.equal(expectedDifficulty(c.chain), want);
  }
  const c = new Blockchain();
  for (let i = 1; i <= 5; i++) c.mine(a.address, i * 100);
  for (let i = 6; i <= 10; i++) c.mine(a.address, 500 + (i - 5) * 3000);
  assert.equal(expectedDifficulty(c.chain), 1);
});
test("highest cumulative work wins even when chain is shorter", () => {
  const a = wallet(),
    fast = new Blockchain(),
    slow = new Blockchain();
  for (let i = 1; i <= 7; i++) fast.mine(a.address, i * 100);
  for (let i = 1; i <= 8; i++) slow.mine(a.address, i * 3000);
  assert.ok(fast.chain.length < slow.chain.length);
  assert.ok(totalWork(fast.chain) > totalWork(slow.chain));
  assert.ok(slow.adopt(fast.chain));
});
test("reorganization returns orphan transfer and can mine it again", () => {
  const { a, b, chain } = setup();
  const other = new Blockchain(chain.chain);
  const t = transfer(a, b.address, 10, 1, 1);
  chain.submit(t);
  chain.mine(b.address, 2000);
  other.mine(b.address, 2001);
  other.mine(b.address, 3001);
  assert.ok(chain.adopt(other.chain));
  assert.equal(chain.mempool.length, 1);
  assert.equal(txId(chain.mempool[0]), txId(t));
  chain.mine(b.address, 4000);
  assert.equal(chain.mempool.length, 0);
  assert.ok(validateChain(chain.chain).valid);
});
test("save/load restores chain and mempool; corrupted file fails closed", () => {
  const { a, b, chain } = setup();
  chain.submit(transfer(a, b.address, 1, 0, 1));
  const file = join(mkdtempSync(join(tmpdir(), "pz1-test-")), "chain.json");
  chain.save(file);
  const restored = Blockchain.load(file);
  assert.deepEqual(restored.chain, chain.chain);
  assert.deepEqual(restored.mempool, chain.mempool);
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.chain[1].transactions[0].amount++;
  writeFileSync(file, JSON.stringify(data));
  assert.throws(() => Blockchain.load(file));
});
