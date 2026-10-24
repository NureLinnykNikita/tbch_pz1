import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonical, hash, checkSignature, txId, NETWORK } from "./crypto.ts";
import type { Transaction, Transfer, Coinbase } from "./crypto.ts";
import { merkleRoot } from "./merkle.ts";

export const REWARD = 50;
export const K = 5;
export const TARGET_MS = 1000;
export const MAX_DIFFICULTY = 6;
export interface Header {
  height: number;
  timestamp: number;
  previousHash: string;
  merkleRoot: string;
  difficulty: number;
  nonce: number;
}

export interface Block {
  header: Header;
  transactions: Transaction[];
  hash: string;
}

interface Account {
  balance: number;
  nonce: number;
}

type State = Map<string, Account>;
function ensure(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(reason);
}

function exact(obj: object, keys: string[]): boolean {
  return Object.keys(obj).sort().join(",") === [...keys].sort().join(",");
}

const address = (s: unknown): boolean =>
  typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const integer = (n: unknown, min = 0): n is number =>
  Number.isSafeInteger(n) && (n as number) >= min;
function add(a: number, b: number): number {
  const n = a + b;
  ensure(Number.isSafeInteger(n), "Integer overflow");
  return n;
}

function account(state: State, addr: string): Account {
  if (!state.has(addr)) state.set(addr, { balance: 0, nonce: 0 });
  return state.get(addr)!;
}

export const blockHash = (header: Header): string => hash(canonical(header));
export function mine(block: Block): Block {
  const result = structuredClone(block);
  ensure(
    integer(result.header.difficulty, 1) &&
      result.header.difficulty <= MAX_DIFFICULTY,
    "Invalid difficulty",
  );
  do {
    result.hash = blockHash(result.header);
    if (result.hash.startsWith("0".repeat(result.header.difficulty)))
      return result;
    result.header.nonce++;
  } while (Number.isSafeInteger(result.header.nonce));
  throw new Error("Nonce exhausted");
}

export function makeBlock(
  previous: Block,
  txs: Transaction[],
  difficulty: number,
  timestamp: number,
): Block {
  return {
    header: {
      height: previous.header.height + 1,
      timestamp,
      previousHash: previous.hash,
      merkleRoot: merkleRoot(txs.map(txId)),
      difficulty,
      nonce: 0,
    },
    transactions: structuredClone(txs),
    hash: "0".repeat(64),
  };
}
const GENESIS: Block = mine({
  header: {
    height: 0,
    timestamp: 0,
    previousHash: "0".repeat(64),
    merkleRoot: merkleRoot([]),
    difficulty: 1,
    nonce: 0,
  },
  transactions: [],
  hash: "",
});
export const genesis = (): Block => structuredClone(GENESIS);
export function expectedDifficulty(chain: Block[]): number {
  const tip = chain.at(-1)!;
  const n = chain.length - 1;
  if (n === 0) return 1;
  if (n % K !== 0) return tip.header.difficulty;
  // K mined blocks give K-1 intervals. Genesis time is excluded.
  const elapsed =
    tip.header.timestamp - chain[chain.length - K].header.timestamp;
  const target = (K - 1) * TARGET_MS;
  const delta = elapsed < target / 2 ? 1 : elapsed > target * 2 ? -1 : 0;
  return Math.min(MAX_DIFFICULTY, Math.max(1, tip.header.difficulty + delta));
}

export function totalWork(chain: Block[]): bigint {
  return chain
    .slice(1)
    .reduce((sum, b) => sum + 16n ** BigInt(b.header.difficulty), 0n);
}

function applyTransfer(tx: Transfer, state: State): void {
  ensure(
    tx?.type === "transfer" &&
      exact(tx, [
        "type",
        "network",
        "from",
        "to",
        "amount",
        "fee",
        "nonce",
        "publicKey",
        "signature",
      ]),
    "Invalid transaction schema",
  );
  ensure(
    tx.network === NETWORK &&
      address(tx.from) &&
      address(tx.to) &&
      integer(tx.amount, 1) &&
      integer(tx.fee) &&
      integer(tx.nonce, 1),
    "Invalid transaction fields",
  );
  ensure(checkSignature(tx), "Invalid signature");
  const sender = account(state, tx.from);
  ensure(
    tx.nonce === sender.nonce + 1,
    `Invalid nonce: expected ${sender.nonce + 1}, got ${tx.nonce}`,
  );
  const cost = add(tx.amount, tx.fee);
  ensure(
    sender.balance >= cost,
    "Insufficient balance (including pending reservations)",
  );
  sender.balance -= cost;
  sender.nonce = tx.nonce;
  account(state, tx.to).balance = add(account(state, tx.to).balance, tx.amount);
}

function replay(chain: Block[], now = Date.now()): State {
  ensure(Array.isArray(chain) && chain.length > 0, "Empty chain");
  ensure(canonical(chain[0]) === canonical(GENESIS), "Invalid genesis");
  const state: State = new Map();
  const ids = new Set<string>();
  for (let i = 1; i < chain.length; i++) {
    const b = chain[i],
      h = b?.header,
      prev = chain[i - 1];
    ensure(
      b &&
        exact(b, ["header", "transactions", "hash"]) &&
        h &&
        exact(h, [
          "height",
          "timestamp",
          "previousHash",
          "merkleRoot",
          "difficulty",
          "nonce",
        ]),
      "Invalid block schema",
    );
    ensure(h.previousHash === prev.hash, `Broken previousHash at block ${i}`);
    ensure(
      h.height === i &&
        integer(h.timestamp) &&
        h.timestamp > prev.header.timestamp &&
        h.timestamp <= now + 120000 &&
        integer(h.nonce),
      "Invalid header fields",
    );
    ensure(
      h.difficulty === expectedDifficulty(chain.slice(0, i)),
      "Unexpected difficulty",
    );
    ensure(b.hash === blockHash(h), `Hash mismatch at block ${i}`);
    ensure(
      b.hash.startsWith("0".repeat(h.difficulty)),
      "Invalid Proof of Work",
    );
    ensure(
      Array.isArray(b.transactions) && b.transactions.length > 0,
      "Block must contain transactions",
    );
    ensure(
      h.merkleRoot === merkleRoot(b.transactions.map(txId)),
      `Merkle root mismatch at block ${i}`,
    );
    const reward = b.transactions[0] as Coinbase;
    ensure(
      reward?.type === "coinbase" &&
        exact(reward, ["type", "to", "amount", "height"]) &&
        reward.height === i &&
        address(reward.to) &&
        integer(reward.amount),
      "Invalid coinbase",
    );
    let fees = 0;
    for (const tx of b.transactions.slice(1)) {
      ensure(tx.type === "transfer", "Coinbase must be first and unique");
      const id = txId(tx);
      ensure(!ids.has(id), "Duplicate confirmed transaction");
      applyTransfer(tx, state);
      ids.add(id);
      fees = add(fees, tx.fee);
    }
    ensure(reward.amount === add(REWARD, fees), "Invalid miner reward");
    account(state, reward.to).balance = add(
      account(state, reward.to).balance,
      reward.amount,
    );
  }
  return state;
}

export function validateChain(chain: Block[]): {
  valid: boolean;
  reason: string;
} {
  try {
    replay(chain);
    return { valid: true, reason: "OK" };
  } catch (e) {
    return { valid: false, reason: (e as Error).message };
  }
}

export class Blockchain {
  chain: Block[];
  mempool: Transfer[] = [];
  constructor(chain: Block[] = [genesis()]) {
    replay(chain);
    this.chain = structuredClone(chain);
  }
  balance(addr: string): number {
    return replay(this.chain).get(addr)?.balance ?? 0;
  }
  nonce(addr: string): number {
    return replay(this.chain).get(addr)?.nonce ?? 0;
  }
  submit(tx: Transfer): string {
    const state = replay(this.chain);
    // Nonce validation precedes the confirmed duplicate check to make replay protection explicit.
    if (tx?.type === "transfer" && tx.nonce <= (state.get(tx.from)?.nonce ?? 0))
      throw new Error("Invalid nonce: transaction already confirmed or stale");
    const id = txId(tx);
    ensure(
      !this.mempool.some((t) => txId(t) === id),
      "Duplicate mempool transaction",
    );
    ensure(
      !this.chain.some((b) => b.transactions.some((t) => txId(t) === id)),
      "Duplicate confirmed transaction",
    );
    for (const pending of this.mempool) applyTransfer(pending, state);
    applyTransfer(tx, state);
    this.mempool.push(structuredClone(tx));
    return id;
  }
  candidate(miner: string, timestamp = Date.now()): Block {
    ensure(address(miner), "Invalid miner address");
    // Беремо мемпул у порядку прийняття: він уже перевірений.
    const reward: Coinbase = {
      type: "coinbase",
      to: miner,
      amount: this.mempool.reduce((sum, tx) => add(sum, tx.fee), REWARD),
      height: this.chain.length,
    };
    return makeBlock(
      this.chain.at(-1)!,
      [reward, ...this.mempool],
      expectedDifficulty(this.chain),
      Math.max(timestamp, this.chain.at(-1)!.header.timestamp + 1),
    );
  }
  mine(miner: string, timestamp?: number): Block {
    const b = mine(this.candidate(miner, timestamp));
    this.append(b);
    return b;
  }
  append(block: Block): void {
    const next = [...this.chain, structuredClone(block)];
    replay(next);
    this.chain = next;
    this.rebuild(this.mempool);
  }
  adopt(candidate: Block[]): boolean {
    replay(candidate);
    if (totalWork(candidate) <= totalWork(this.chain)) return false;
    const orphaned = this.chain
      .slice(1)
      .flatMap((b) =>
        b.transactions.filter((t): t is Transfer => t.type === "transfer"),
      );
    this.chain = structuredClone(candidate);
    this.rebuild([...this.mempool, ...orphaned]);
    return true;
  }
  private rebuild(pool: Transfer[]): void {
    this.mempool = [];
    let pending = [...new Map(pool.map((t) => [txId(t), t])).values()];
    // Multiple passes recover transfers whose nonce/funding dependencies appear later.
    while (pending.length) {
      const failed: Transfer[] = [];
      let progress = false;
      for (const tx of pending) {
        try {
          this.submit(tx);
          progress = true;
        } catch {
          failed.push(tx);
        }
      }
      if (!progress) break;
      pending = failed;
    }
  }
  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path + ".tmp",
      JSON.stringify(
        { version: 1, chain: this.chain, mempool: this.mempool },
        null,
        2,
      ),
    );
    renameSync(path + ".tmp", path);
  }
  static load(path: string): Blockchain {
    const data = JSON.parse(readFileSync(path, "utf8"));
    ensure(
      data.version === 1 && Array.isArray(data.mempool),
      "Invalid storage format",
    );
    const result = new Blockchain(data.chain);
    result.rebuild(data.mempool);
    return result;
  }
}
