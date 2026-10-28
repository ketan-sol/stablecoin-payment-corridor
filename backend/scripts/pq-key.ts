/**
 * Post-quantum key tool for people who hold a PQAccount: compliance officers, the admin's timelock proposer, a
 * business paying from one. Run from backend/:
 *
 *   npx tsx scripts/pq-key.ts keygen  --key officer-b.pqkey.json [--height 10]
 *   npx tsx scripts/pq-key.ts status  --key officer-b.pqkey.json
 *   npx tsx scripts/pq-key.ts execute --key officer-b.pqkey.json --account 0xPQAccount --chain-id 5042002 \
 *        --to 0xEscrow --fn "refund(bytes32)" --args '["0xKey"]' [--valid-min 60]
 *   npx tsx scripts/pq-key.ts erc1271 --key buyer.pqkey.json --account 0xPQAccount --chain-id 11155111 --hash 0xDigest
 *
 * Name key files *.pqkey.json (gitignored). `execute` prints calldata for the PQAccount: send it from any wallet (that wallet only pays gas), e.g.
 *   cast send 0xPQAccount <data> --rpc-url $ARC_RPC_URL --interactive
 * Each signature uses the next one-time leaf, and the key file is updated on disk BEFORE the signature is printed:
 * never copy or restore an older key file, or a leaf gets signed twice.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { bytesToHex, encodeFunctionData, getAddress, parseAbiItem, type Address, type Hex } from 'viem'
import { encodeSignature, erc1271Digest, executeDigest, PQSigner } from '../src/pq'

export interface KeyFile {
  secret: Hex
  seed: Hex
  height: number
  root: Hex
  next: number // next unused leaf
}

const read = (path: string): KeyFile => JSON.parse(readFileSync(path, 'utf8'))
function write(path: string, k: KeyFile) {
  writeFileSync(`${path}.tmp`, JSON.stringify(k, null, 2), { mode: 0o600, flag: 'w' })
  renameSync(`${path}.tmp`, path) // atomic: the file is the old state or the new one, never half
}

export function keygen(path: string, height = 10): KeyFile {
  if (existsSync(path)) throw new Error(`${path} exists; refusing to overwrite a key`)
  const secret = bytesToHex(randomBytes(32))
  const seed = bytesToHex(randomBytes(32))
  const k = { secret, seed, height, root: new PQSigner(secret, seed, height).root, next: 0 }
  write(path, k)
  return k
}

/** Burns the next leaf in the key file, then signs `m` with it. */
function signNext(path: string, m: (k: KeyFile) => Hex) {
  const k = read(path)
  const signer = new PQSigner(k.secret, k.seed, k.height)
  if (signer.root !== k.root) throw new Error('key file is corrupt: root does not match secret/seed/height')
  const leaf = k.next
  if (leaf >= signer.capacity) throw new Error(`all ${signer.capacity} leaves used; rotate to a new key`)
  write(path, { ...k, next: leaf + 1 })
  return signer.sign(leaf, m(k))
}

const pqExecute = parseAbiItem(
  'function execute(address to, bytes data, uint256 deadline, (uint256 leaf, bytes32[67] wots, bytes32[] path) sig) returns (bytes)',
)

export function execute(o: { key: string; account: Address; chainId: number; to: Address; fn: string; args: unknown[]; deadline: bigint }) {
  const inner = encodeFunctionData({ abi: [parseAbiItem(`function ${o.fn.replace(/^function\s+/, '')}`)], args: o.args } as never)
  const sig = signNext(o.key, () => executeDigest(o.chainId, o.account, o.to, inner, o.deadline))
  return { leaf: Number(sig.leaf), to: o.account, data: encodeFunctionData({ abi: [pqExecute], args: [o.to, inner, o.deadline, sig as never] }) }
}

export function erc1271(o: { key: string; account: Address; chainId: number; hash: Hex }) {
  const sig = signNext(o.key, () => erc1271Digest(o.chainId, o.account, o.hash))
  return { leaf: Number(sig.leaf), signature: encodeSignature(sig) }
}

function main(argv: string[]) {
  const { positionals, values: v } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      key: { type: 'string' },
      height: { type: 'string' },
      account: { type: 'string' },
      'chain-id': { type: 'string' },
      to: { type: 'string' },
      fn: { type: 'string' },
      args: { type: 'string', default: '[]' },
      'valid-min': { type: 'string', default: '60' },
      hash: { type: 'string' },
    },
  })
  const need = (x: string | undefined, name: string) => {
    if (!x) throw new Error(`--${name} is required`)
    return x
  }
  const key = need(v.key, 'key')
  const out = (x: unknown) => console.log(JSON.stringify(x, null, 2))
  switch (positionals[0]) {
    case 'keygen': {
      const k = keygen(key, Number(v.height ?? 10))
      out({ key, root: k.root, seed: k.seed, height: k.height, signatures: 2 ** k.height })
      console.error(`Deploy: PQ_ROOT=${k.root} PQ_SEED=${k.seed} PQ_HEIGHT=${k.height} forge script script/Deploy.s.sol --sig "pqAccount()" ...`)
      console.error(`${key} holds the secret: keep it like a private key, back it up once, never restore an older copy.`)
      return
    }
    case 'status': {
      const k = read(key)
      return out({ root: k.root, used: k.next, left: 2 ** k.height - k.next })
    }
    case 'execute': {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * Number(v['valid-min']))
      const r = execute({
        key,
        account: getAddress(need(v.account, 'account')),
        chainId: Number(need(v['chain-id'], 'chain-id')),
        to: getAddress(need(v.to, 'to')),
        fn: need(v.fn, 'fn'),
        args: JSON.parse(v.args!),
        deadline,
      })
      out({ ...r, deadline: deadline.toString() })
      console.error(`Send it (any wallet pays gas): cast send ${r.to} ${r.data.slice(0, 18)}… --rpc-url <rpc> --interactive`)
      return
    }
    case 'erc1271':
      return out(erc1271({ key, account: getAddress(need(v.account, 'account')), chainId: Number(need(v['chain-id'], 'chain-id')), hash: need(v.hash, 'hash') as Hex }))
    default:
      throw new Error('usage: pq-key.ts keygen|status|execute|erc1271 --key <file> … (see the header of this file)')
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }
}
