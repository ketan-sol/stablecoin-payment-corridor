import type { Config } from './config'
import type { Db } from './db'
import type { Gateway } from './chain/gateway'
import type { JobQueue } from './queue'
import type { FxSource } from './services/fx'
import type { KybVendor } from './services/vendor'

/** Everything a service needs; built once in index.ts, faked in tests. */
export interface Ctx {
  cfg: Config
  db: Db
  gw: Gateway
  queue: JobQueue
  fx: FxSource
  vendor: KybVendor
  log: (msg: string, data?: Record<string, unknown>) => void
}

export const silentLog: Ctx['log'] = () => {}
