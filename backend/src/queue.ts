import { Queue, Worker, type ConnectionOptions } from 'bullmq'

export interface JobOptions {
  delayMs?: number
  /** Jobs with the same id are deduplicated while one is waiting. Idempotency key = payment ID. */
  jobId?: string
}

export type Handler = (data: Record<string, unknown>) => Promise<void>

/** The orchestrator's job queue: BullMQ on Redis in production, an in-process queue for dev and tests. */
export interface JobQueue {
  add(name: string, data: Record<string, unknown>, opts?: JobOptions): Promise<void>
  process(name: string, handler: Handler): void
  /** Waiting + delayed jobs, for the ops health view. */
  depth(): Promise<number>
  close(): Promise<void>
}

export class MemoryQueue implements JobQueue {
  private handlers = new Map<string, Handler>()
  private pending = new Map<string, NodeJS.Timeout>()
  private closed = false
  errors: { name: string; error: unknown }[] = []

  async add(name: string, data: Record<string, unknown>, opts: JobOptions = {}) {
    if (this.closed) return
    const key = `${name}:${opts.jobId ?? Math.random()}`
    if (this.pending.has(key)) return
    const timer = setTimeout(async () => {
      this.pending.delete(key)
      const h = this.handlers.get(name)
      if (!h || this.closed) return
      try {
        await h(data)
      } catch (error) {
        this.errors.push({ name, error })
      }
    }, opts.delayMs ?? 0)
    this.pending.set(key, timer)
  }

  process(name: string, handler: Handler) {
    this.handlers.set(name, handler)
  }

  async depth() {
    return this.pending.size
  }

  async close() {
    this.closed = true
    for (const t of this.pending.values()) clearTimeout(t)
    this.pending.clear()
  }
}

export class BullQueue implements JobQueue {
  private queue: Queue
  private workers: Worker[] = []
  private connection: ConnectionOptions

  constructor(redisUrl: string, name = 'corridor') {
    const u = new URL(redisUrl)
    this.connection = { host: u.hostname, port: Number(u.port || 6379), password: u.password || undefined }
    this.queue = new Queue(name, { connection: this.connection })
  }

  async add(name: string, data: Record<string, unknown>, opts: JobOptions = {}) {
    await this.queue.add(name, data, {
      delay: opts.delayMs,
      jobId: opts.jobId ? `${name}-${opts.jobId}` : undefined,
      removeOnComplete: true,
      removeOnFail: 1000,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
    })
  }

  process(name: string, handler: Handler) {
    // One worker per job name; BullMQ routes by name inside the shared queue.
    const w = new Worker(
      this.queue.name,
      async (job) => {
        if (job.name === name) await handler(job.data)
      },
      { connection: this.connection, concurrency: 4 },
    )
    this.workers.push(w)
  }

  async depth() {
    const c = await this.queue.getJobCounts('waiting', 'delayed')
    return (c.waiting ?? 0) + (c.delayed ?? 0)
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.close()))
    await this.queue.close()
  }
}
