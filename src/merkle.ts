import { hash } from "./crypto.ts";

const pair = (a: string, b: string): string => hash(Buffer.from(a + b, "hex"));

export function merkleRoot(leaves: string[]): string {
  if (!leaves.length) return hash("");
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(pair(level[i], level[i + 1] ?? level[i]));
    level = next;
  }
  return level[0];
}
