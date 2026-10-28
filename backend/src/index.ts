import { buildApi } from './api'
import { viemGateway } from './chain/viemGateway'
import { reserveLeaf } from './pq'
import { loadConfig } from './config'
import type { Ctx } from './ctx'
import { pqTlsAvailable, tlsKeyExchange } from './crypto'
import { openDb } from './db'
import { BullQueue, MemoryQueue, type JobQueue } from './queue'
import { mockFx } from './services/fx'
import { indexOnce } from './services/indexer'
import { advance, resumeAll } from './services/orchestrator'
import { runReconciliation } from './services/reconciliation'
import { sandboxVendor } from './services/vendor'
import { deliverWebhook } from './services/webhooks'

const cfg = loadConfig()
const log: Ctx['log'] = (msg, data) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }))

const { db, close } = await openDb({ url: cfg.env.DATABASE_URL, dir: cfg.env.PGLITE_DIR })
const queue: JobQueue = cfg.env.REDIS_URL ? new BullQueue(cfg.env.REDIS_URL) : new MemoryQueue()
const ctx: Ctx = { cfg, db, gw: viemGateway(cfg, (root) => reserveLeaf(db, root)), queue, fx: mockFx, vendor: sandboxVendor, log }

queue.process('advance', async ({ id }) => void (await advance(ctx, String(id))))
queue.process('webhook', async ({ id }) => deliverWebhook(ctx, String(id)))

// Post-quantum TLS to every upstream: warn if this runtime cannot, or an upstream only speaks classical key exchange.
if (!pqTlsAvailable()) log('warning: no ML-KEM in this Node/OpenSSL; TLS to RPCs and Circle is classical. Use Node 24+ with OpenSSL 3.5+')
const upstreams = [cfg.network.settlement.rpcUrl, ...Object.values(cfg.network.sources).map((s) => s.rpcUrl), ...(cfg.network.kind === 'local' ? [] : [cfg.env.IRIS_URL])]
void Promise.all([...new Set(upstreams)].map(async (u) => [new URL(u).host, await tlsKeyExchange(u)] as const)).then((r) => {
  const classical = r.filter(([, g]) => g && !g.includes('MLKEM')).map(([h]) => h)
  log(classical.length ? 'warning: classical TLS key exchange (recordable now, decryptable later)' : 'tls key exchange', Object.fromEntries(r))
})

const resumed = await resumeAll(ctx)

// Indexer: one pass per poll; a failing pass (RPC hiccup) is retried on the next tick.
let indexing = false
const indexer = setInterval(async () => {
  if (indexing) return
  indexing = true
  try {
    await indexOnce(ctx)
  } catch (e) {
    log('indexer error', { error: (e as Error).message })
  } finally {
    indexing = false
  }
}, cfg.env.POLL_MS)

// Reconciliation and the settlement report: daily, plus once at start.
const recon = () => runReconciliation(ctx).catch((e) => log('reconciliation error', { error: (e as Error).message }))
setTimeout(recon, 10_000)
const daily = setInterval(recon, 24 * 3600_000)

const app = buildApi(ctx)
await app.listen({ port: cfg.env.PORT, host: '0.0.0.0' })
log('corridor backend up', {
  port: cfg.env.PORT,
  network: cfg.network.kind,
  db: cfg.env.DATABASE_URL ? 'postgres' : `pglite:${cfg.env.PGLITE_DIR}`,
  queue: cfg.env.REDIS_URL ? 'bullmq' : 'memory',
  resumed,
})

const shutdown = async () => {
  clearInterval(indexer)
  clearInterval(daily)
  await app.close()
  await queue.close()
  await close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
