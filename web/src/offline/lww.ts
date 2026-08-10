import type { Note } from '../types'

/** Returns true when `a` should win over `b` (LWW + mutation id tie-break). */
export function isNewerMutation(
  a: { clientUpdatedAt?: string | null; updatedAt: string; clientMutationId?: string | null },
  b: { clientUpdatedAt?: string | null; updatedAt: string; clientMutationId?: string | null },
): boolean {
  const aTime = Date.parse(a.clientUpdatedAt || a.updatedAt)
  const bTime = Date.parse(b.clientUpdatedAt || b.updatedAt)
  if (aTime !== bTime) return aTime > bTime
  return (a.clientMutationId || '') > (b.clientMutationId || '')
}

export function noteIsNewer(candidate: Note, current: Note): boolean {
  return isNewerMutation(candidate, current)
}

export function newMutationId(): string {
  return crypto.randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}
