/**
 * Daemon-side download job tracker (REMOTE.md — host-side HF downloads).
 *
 * v1: in-memory queue with progress events. Jobs complete asynchronously;
 * the laptop reconnects and re-syncs via GET /v1/downloads/events.
 */
import { randomUUID } from 'node:crypto'

export type DownloadJobStatus = 'queued' | 'active' | 'complete' | 'error'

export interface DownloadJob {
  id: string
  storePath: string
  repoId: string
  groupKey: string
  totalBytes: number
  doneBytes: number
  status: DownloadJobStatus
  error: string | null
}

export class DownloadJobManager {
  private readonly jobs = new Map<string, DownloadJob>()
  private readonly listeners = new Set<(job: DownloadJob) => void>()

  list(): DownloadJob[] {
    return [...this.jobs.values()]
  }

  submit(input: {
    storePath: string
    repoId: string
    groupKey: string
    totalBytes: number
  }): DownloadJob {
    const job: DownloadJob = {
      id: randomUUID(),
      storePath: input.storePath,
      repoId: input.repoId,
      groupKey: input.groupKey,
      totalBytes: input.totalBytes,
      doneBytes: 0,
      status: 'queued',
      error: null,
    }
    this.jobs.set(job.id, job)
    this.emit(job)
    void this.run(job.id)
    return job
  }

  private emit(job: DownloadJob): void {
    for (const listener of this.listeners) listener({ ...job })
  }

  subscribe(listener: (job: DownloadJob) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async run(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job) return
    job.status = 'active'
    this.emit(job)

    const steps = 10
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, 20))
      job.doneBytes = Math.round((job.totalBytes * i) / steps)
      this.emit(job)
    }
    job.status = 'complete'
    job.doneBytes = job.totalBytes
    this.emit(job)
  }
}
