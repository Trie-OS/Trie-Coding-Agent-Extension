/**
 * Remote host wire types (REMOTE.md).
 */
import { z } from 'zod'

z.config({ jitless: true })

export const remoteHostStatusSchema = z.enum([
  'unconfigured',
  'ready',
  'unreachable',
  'bootstrap_required',
])
export type RemoteHostStatus = z.infer<typeof remoteHostStatusSchema>

export const remoteHostAuthKindSchema = z.enum(['key', 'agent'])
export type RemoteHostAuthKind = z.infer<typeof remoteHostAuthKindSchema>

export const remoteHostSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  username: z.string().min(1),
  authKind: remoteHostAuthKindSchema,
  keyPath: z.string().nullable(),
  hostKeyFp: z.string().nullable(),
  platform: z.string().nullable(),
  ramBytes: z.number().int().nonnegative().nullable(),
  gpu: z.string().nullable(),
  daemonVersion: z.string().nullable(),
  status: remoteHostStatusSchema,
  createdAt: z.number().int().positive(),
  lastSeenAt: z.number().int().positive().nullable(),
})
export type RemoteHost = z.infer<typeof remoteHostSchema>

export const daemonHandshakeSchema = z.object({
  version: z.string().min(1),
  platform: z.string().min(1),
  ramBytes: z.number().int().nonnegative(),
  gpu: z.string().nullable(),
  freeDiskBytes: z.number().nonnegative().nullable(),
})
export type DaemonHandshake = z.infer<typeof daemonHandshakeSchema>

/** Daemon protocol version — bump when breaking API changes. */
export const DAEMON_PROTOCOL_VERSION = '1.0.0'
