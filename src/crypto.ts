import {
  createHash,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

export const NETWORK = "nure-pz1-v1";
// JSON values only: recursively sorted object keys; arrays retain their order.
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(obj[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error("Unsupported canonical value");
}

export const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
export const addressOf = (publicKey: string): string =>
  hash(Buffer.from(publicKey, "hex"));
export interface Wallet {
  address: string;
  publicKey: string;
  privateKey: string;
}

export function wallet(): Wallet {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("hex");
  return {
    address: addressOf(publicKey),
    publicKey,
    privateKey: keys.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("hex"),
  };
}

export interface Transfer {
  type: "transfer";
  network: string;
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  publicKey: string;
  signature: string;
}

export interface Coinbase {
  type: "coinbase";
  to: string;
  amount: number;
  height: number;
}

export type Transaction = Transfer | Coinbase;
export function payload(tx: Transfer): Omit<Transfer, "signature"> {
  const { signature: _, ...unsigned } = tx;
  return unsigned;
}

export function transfer(
  w: Wallet,
  to: string,
  amount: number,
  fee: number,
  nonce: number,
): Transfer {
  const tx: Transfer = {
    type: "transfer",
    network: NETWORK,
    from: w.address,
    to,
    amount,
    fee,
    nonce,
    publicKey: w.publicKey,
    signature: "",
  };
  tx.signature = sign(
    null,
    Buffer.from(canonical(payload(tx))),
    createPrivateKey({
      key: Buffer.from(w.privateKey, "hex"),
      format: "der",
      type: "pkcs8",
    }),
  ).toString("hex");
  return tx;
}

export const txId = (tx: Transaction): string => hash(canonical(tx));
export function checkSignature(tx: Transfer): boolean {
  try {
    if (
      !/^[0-9a-f]{88}$/.test(tx.publicKey) ||
      !/^[0-9a-f]{128}$/.test(tx.signature)
    )
      return false;
    const key = createPublicKey({
      key: Buffer.from(tx.publicKey, "hex"),
      format: "der",
      type: "spki",
    });
    return (
      key.asymmetricKeyType === "ed25519" &&
      addressOf(tx.publicKey) === tx.from &&
      verify(
        null,
        Buffer.from(canonical(payload(tx))),
        key,
        Buffer.from(tx.signature, "hex"),
      )
    );
  } catch {
    return false;
  }
}
