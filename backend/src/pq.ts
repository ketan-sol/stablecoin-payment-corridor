import { sql } from 'drizzle-orm'
import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, type Address, type Hex } from 'viem'
import type { Db } from './db'
import { pqLeaves } from './db/schema'

/** Signer for PQAccount (contracts/src/PQAccount.sol): Winternitz one-time keys (w = 16, keccak256) under a Merkle
 * tree of 2^height leaves. Must produce exactly the bytes the contract verifies; the vector test pins both sides. */

export interface PQSignature {
  leaf: bigint
  wots: readonly Hex[] // 67
  path: readonly Hex[] // height
}

const CHAINS = 67
const EXECUTE = keccak256(new TextEncoder().encode('PQAccount.execute'))
const k = (b: Uint8Array) => keccak256(b, 'bytes')

/** Writes n as a big-endian uint256 into buf at offset (n < 2^53). */
function putUint(buf: Uint8Array, offset: number, n: number) {
  buf.fill(0, offset, offset + 32)
  for (let i = offset + 31; n > 0; i--, n = Math.floor(n / 256)) buf[i] = n % 256
}

export class PQSigner {
  readonly root: Hex
  private levels: Uint8Array[][]
  private secret: Uint8Array
  private seed: Uint8Array
  private buf = new Uint8Array(96)

  constructor(secret: Hex, seed: Hex, readonly height: number) {
    if (height < 1 || height > 20) throw new Error('PQ height must be 1..20')
    this.secret = hexToBytes(secret, { size: 32 })
    this.seed = hexToBytes(seed, { size: 32 })
    // ponytail: the whole tree is rebuilt at startup, ~1,005 hashes a leaf (~6 s at height 10, ~25 s at 12); cache
    // the leaves on disk if a taller tree makes that slow.
    const leaves = Array.from({ length: 2 ** height }, (_, leaf) => this.leafHash(leaf))
    this.levels = [leaves]
    for (let l = 1; l <= height; l++) {
      const below = this.levels[l - 1]
      this.levels.push(Array.from({ length: below.length / 2 }, (_, i) => this.node(below[2 * i], below[2 * i + 1])))
    }
    this.root = bytesToHex(this.levels[height][0])
  }

  get capacity() {
    return 2 ** this.height
  }

  /** One leaf, one message, ever: the caller reserves `leaf` durably before calling. */
  sign(leaf: number, m: Hex): PQSignature {
    if (leaf < 0 || leaf >= this.capacity) throw new Error(`PQ key exhausted (leaf ${leaf} of ${this.capacity}); rotate`)
    const d = digits(hexToBytes(m))
    return {
      leaf: BigInt(leaf),
      wots: d.map((di, i) => bytesToHex(this.chain(this.secretChain(leaf, i), leaf, i, 0, di))),
      path: Array.from({ length: this.height }, (_, l) => bytesToHex(this.levels[l][(leaf >> l) ^ 1])),
    }
  }

  private secretChain(leaf: number, i: number) {
    const b = new Uint8Array(96)
    b.set(this.secret, 0)
    putUint(b, 32, leaf)
    putUint(b, 64, i)
    return k(b)
  }

  /** Steps [from, to) of chain i: x = keccak256(seed, leaf << 16 | i << 8 | j, x), as PQAccount._chain. */
  private chain(x: Uint8Array, leaf: number, i: number, from: number, to: number) {
    const b = this.buf
    b.set(this.seed, 0)
    for (let j = from; j < to; j++) {
      putUint(b, 32, leaf * 65536 + i * 256 + j)
      b.set(x, 64)
      x = k(b)
    }
    return x
  }

  private leafHash(leaf: number) {
    const pk = new Uint8Array(32 * CHAINS)
    for (let i = 0; i < CHAINS; i++) pk.set(this.chain(this.secretChain(leaf, i), leaf, i, 0, 15), 32 * i)
    return k(pk)
  }

  private node(a: Uint8Array, b: Uint8Array) {
    const n = new Uint8Array(64)
    n.set(a, 0)
    n.set(b, 32)
    return k(n)
  }
}

/** 64 base-16 digits of the message, then 3 checksum digits. */
export function digits(m: Uint8Array): number[] {
  const d: number[] = []
  for (let i = 0; i < 64; i++) d.push((m[i >> 1] >> (i & 1 ? 0 : 4)) & 15)
  const checksum = d.reduce((s, x) => s + 15 - x, 0)
  for (let i = 0; i < 3; i++) d.push((checksum >> (8 - 4 * i)) & 15)
  return d
}

/** PQAccount.executeDigest. */
export function executeDigest(chainId: number, account: Address, to: Address, data: Hex, deadline: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }],
      [EXECUTE, BigInt(chainId), account, to, keccak256(data), deadline],
    ),
  )
}

/** The next unused leaf of the tree with this root, durably reserved (atomic, so concurrent sends never share one). A
 * leaf whose transaction later fails stays used: its signature may already be public. */
export async function reserveLeaf(db: Db, root: Hex): Promise<number> {
  const [r] = await db
    .insert(pqLeaves)
    .values({ root, next: 0 })
    .onConflictDoUpdate({ target: pqLeaves.root, set: { next: sql`${pqLeaves.next} + 1` } })
    .returning({ next: pqLeaves.next })
  return r.next
}
