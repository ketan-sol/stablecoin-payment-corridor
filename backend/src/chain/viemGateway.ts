import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
  nonceManager,
  parseAbi,
  toEventSelector,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  complianceRegistryAbi,
  erc20Abi,
  localCctpAbi,
  paymentEscrowAbi,
  paymentRouterAbi,
} from '@corridor/shared'
import type { Config } from '../config'
import { executeDigest, PQSigner } from '../pq'
import { ESCROW_STATUS, type ChainHealth, type EscrowRecord, type Gateway, type Receipt } from './gateway'

const MESSAGE_SENT_TOPIC = toEventSelector('MessageSent(bytes)') // MessageTransmitterV2 (and LocalCCTP)

/** Permit2's errors, so a rejected permit reads "SignatureExpired" instead of a bare selector. */
const routerWithPermit2Errors = [
  ...paymentRouterAbi,
  ...parseAbi([
    'error SignatureExpired(uint256 signatureDeadline)',
    'error InvalidSigner()',
    'error InvalidSignature()',
    'error InvalidSignatureLength()',
    'error InvalidNonce()',
    'error InvalidAmount(uint256 maxAmount)',
  ]),
] as const

const pqAccountAbi = parseAbi([
  'function execute(address to, bytes data, uint256 deadline, (uint256 leaf, bytes32[67] wots, bytes32[] path) sig) returns (bytes)',
  'function root() view returns (bytes32)',
  'error BadSignature()',
  'error Expired()',
  'error LeafSpent(uint256 leaf)',
])

/** `reserveLeaf` (DB-backed, see pq.ts) is required when cfg.pq is set. */
export function viemGateway(cfg: Config, reserveLeaf?: (root: Hex) => Promise<number>): Gateway {
  const { network } = cfg
  // One nonce manager per key: the API relays pays while workers send settlement transactions.
  const relayer = privateKeyToAccount(cfg.relayerKey, { nonceManager })

  const clientsFor = (chainId: number, rpcUrl: string, name: string) => {
    const chain = defineChain({
      id: chainId,
      name,
      nativeCurrency: { name: 'native', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    })
    return {
      pub: createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient,
      relayer: createWalletClient({ chain, account: relayer, transport: http(rpcUrl) }),
    }
  }
  const s = network.settlement
  const clients: Record<string, ReturnType<typeof clientsFor>> = {
    settlement: clientsFor(s.chainId, s.rpcUrl, s.name),
  }
  for (const src of Object.values(network.sources)) clients[src.key] = clientsFor(src.chainId, src.rpcUrl, src.name)
  const c = (chain: string) => {
    const x = clients[chain]
    if (!x) throw new Error(`unknown chain ${chain}`)
    return x
  }
  const arc = clients.settlement
  const escrow = { address: s.escrow, abi: paymentEscrowAbi } as const
  const registry = { address: s.registry, abi: complianceRegistryAbi } as const

  // Settlement-chain roles: sent by the relayer key, or, with a PQAccount, signed by its hash-based key and only
  // paid for by the relayer (whose ECDSA key then holds no role there).
  if (cfg.pq && !reserveLeaf) throw new Error('PQ_ACCOUNT is set but no leaf store was given')
  const pq = cfg.pq ? { ...cfg.pq, signer: new PQSigner(cfg.pq.secret, cfg.pq.seed, cfg.pq.height) } : null
  let pqChecked: Promise<void> | undefined
  async function asRole(target: { address: Address; abi: Abi }, functionName: string, args: readonly unknown[]): Promise<Hash> {
    const call = { ...target, functionName, args } as never
    if (!pq) return arc.relayer.writeContract(call)
    pqChecked ??= arc.pub.readContract({ address: pq.account, abi: pqAccountAbi, functionName: 'root' }).then(
      (r) => {
        if (r !== pq.signer.root) throw new Error(`PQ key root ${pq.signer.root} does not match PQAccount ${pq.account} root ${r}`)
      },
      (e) => {
        pqChecked = undefined
        throw e
      },
    )
    await pqChecked
    const data = encodeFunctionData(call)
    const deadline = (await arc.pub.getBlock()).timestamp + 3600n // chain time: the local chain may be warped ahead
    const leaf = await reserveLeaf!(pq.signer.root)
    const sig = pq.signer.sign(leaf, executeDigest(s.chainId, pq.account, target.address, data, deadline))
    return arc.relayer.writeContract({
      address: pq.account,
      abi: [...pqAccountAbi, ...target.abi], // the target's errors bubble up through execute
      functionName: 'execute',
      args: [target.address, data, deadline, sig],
    } as never)
  }

  return {
    async receipt(chain, hash): Promise<Receipt> {
      const r = await c(chain).pub.getTransactionReceipt({ hash }).catch(() => null)
      if (!r) return { status: 'pending' }
      return { status: r.status, blockNumber: Number(r.blockNumber), blockHash: r.blockHash, logs: r.logs }
    },
    blockNumber: async (chain) => Number(await c(chain).pub.getBlockNumber()),
    verifyTypedData: (chain, signer, typedData, signature) =>
      c(chain).pub.verifyTypedData({ ...typedData, address: signer, signature }).catch(() => false),
    async now(chain = 'settlement') {
      // Anvil (automine) only advances its clock when it mines, so after a warp the latest block can trail the
      // time the next transaction sees by however long the chain sat idle. Mine one to read the real time.
      if (network.kind === 'local') await c(chain).pub.request({ method: 'evm_mine' as never, params: [] as never })
      return Number((await c(chain).pub.getBlock()).timestamp)
    },
    logs: (chain, address, fromBlock, toBlock) =>
      c(chain).pub.getLogs({ address, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) }),

    pay: (source, intent, permit, sender, signature) =>
      c(source).relayer.writeContract({
        address: network.sources[source].router,
        abi: routerWithPermit2Errors,
        functionName: 'pay',
        args: [intent, permit, sender, signature],
      }),
    payBatch: (source, batch, permit, sender, signature) =>
      c(source).relayer.writeContract({
        address: network.sources[source].router,
        abi: routerWithPermit2Errors,
        functionName: 'payBatch',
        args: [batch, permit, sender, signature],
      }),

    async cctpMessage(source, payTx) {
      const r = await c(source).pub.getTransactionReceipt({ hash: payTx })
      const log = r.logs.find((l) => l.topics[0] === MESSAGE_SENT_TOPIC)
      if (!log) return null
      const { args } = decodeEventLog({ abi: localCctpAbi, eventName: 'MessageSent', data: log.data, topics: log.topics })
      return args.message
    },

    async attestation(source, payTx, message) {
      if (network.kind === 'local') return { message, attestation: '0x' } // LocalCCTP has no attester
      const domain = network.sources[source].domain
      const res = await fetch(`${cfg.env.IRIS_URL}/v2/messages/${domain}?transactionHash=${payTx}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`Circle attestation API: HTTP ${res.status}`)
      const body = (await res.json()) as { messages?: { message: Hex; attestation: Hex; status: string }[] }
      const m = body.messages?.[0]
      // Iris returns the message with the nonce filled in; deliver that one, not the burn-time copy.
      return m?.status === 'complete' ? { message: m.message, attestation: m.attestation } : null
    },

    receivePayment: (message, attestation) => asRole(escrow, 'receivePayment', [message, attestation]),
    release: (key, to) => asRole(escrow, 'release', [key, to]),
    freeze: (key) => asRole(escrow, 'freeze', [key]),
    claimRefund: (key) => arc.relayer.writeContract({ ...escrow, functionName: 'claimRefundAfterTimeout', args: [key] }),

    async escrowPayment(key): Promise<EscrowRecord> {
      const [token, sender, receiver, refundTo, amount, escrowedAt, status] = await arc.pub.readContract({
        ...escrow,
        functionName: 'payments',
        args: [key],
      })
      return { token, sender, receiver, refundTo, amount, escrowedAt: Number(escrowedAt), status: ESCROW_STATUS[status] }
    },
    refundWindow: async () => Number(await arc.pub.readContract({ ...escrow, functionName: 'refundWindow' })),
    totalHeld: (token) => arc.pub.readContract({ ...escrow, functionName: 'totalHeld', args: [token] }),
    isAllowed: (from, to) => arc.pub.readContract({ ...registry, functionName: 'isAllowed', args: [from, to] }),
    isVerified: (a) => arc.pub.readContract({ ...registry, functionName: 'isVerified', args: [a] }),
    isSanctioned: (a) => arc.pub.readContract({ ...registry, functionName: 'isSanctioned', args: [a] }),
    setAttestation: (account, uid, expiresAt) => asRole(registry, 'setAttestation', [account, uid, BigInt(expiresAt)]),

    warp:
      network.kind === 'local'
        ? async (seconds) => {
            await arc.pub.request({ method: 'evm_increaseTime' as never, params: [seconds] as never })
            await arc.pub.request({ method: 'evm_mine' as never, params: [] as never })
          }
        : undefined,

    async health(): Promise<ChainHealth[]> {
      const seen = new Map<string, Promise<ChainHealth>>()
      for (const [key, x] of Object.entries(clients)) {
        const rpc = key === 'settlement' ? s.rpcUrl : network.sources[key].rpcUrl
        if (seen.has(rpc)) continue // local mode: one chain plays every role
        seen.set(
          rpc,
          (async () => {
            try {
              const [block, bal] = await Promise.all([x.pub.getBlockNumber(), x.pub.getBalance({ address: relayer.address })])
              return { chain: key, ok: true, block: Number(block), relayerNative: formatEther(bal) }
            } catch (e) {
              return { chain: key, ok: false, block: null, relayerNative: null, error: (e as Error).message.slice(0, 120) }
            }
          })(),
        )
      }
      return Promise.all(seen.values())
    },

    async feeVaultBalances() {
      return Promise.all(
        Object.values(network.sources).map(async (src) => {
          const bal = await c(src.key).pub.readContract({
            address: src.token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [src.feeVault as Address],
          })
          return { chain: src.key, token: src.tokenSymbol, balance: bal.toString() }
        }),
      )
    },
  }
}

export type { Hash, Hex }
