import { api, ApiError } from '../api'
import type { LocalRepository } from '../offline/repository'

const DELETE_CONCURRENCY = 4

async function listAllActiveNoteIds(): Promise<string[]> {
  const ids: string[] = []
  let updatedAfter: string | undefined
  let afterId: string | undefined
  let hasMore = true
  while (hasMore) {
    const page = await api.notes({
      limit: 200,
      updatedAfter,
      afterId,
    })
    for (const item of page.items) ids.push(item.id)
    hasMore = page.hasMore
    const nextUpdatedAfter = page.nextUpdatedAfter ?? undefined
    const nextAfterId = page.nextAfterId ?? undefined
    if (hasMore && nextUpdatedAfter === updatedAfter && nextAfterId === afterId) break
    updatedAfter = nextUpdatedAfter
    afterId = nextAfterId
  }
  return ids
}

async function ignoreMissing(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return
    throw error
  }
}

async function deleteInBatches(
  ids: string[],
  del: (id: string) => Promise<void>,
  onProgress: (percent: number) => void,
  offset: number,
  total: number,
): Promise<void> {
  for (let i = 0; i < ids.length; i += DELETE_CONCURRENCY) {
    const batch = ids.slice(i, i + DELETE_CONCURRENCY)
    await Promise.all(batch.map((id) => ignoreMissing(() => del(id))))
    onProgress(Math.round(((offset + i + batch.length) / Math.max(total, 1)) * 100))
  }
}

export async function wipeVaultContent(
  repo: LocalRepository,
  onProgress: (percent: number) => void,
): Promise<void> {
  onProgress(0)
  await repo.clearOutbox()
  const noteIds = await listAllActiveNoteIds()
  const labels = await api.listLabels()
  const labelIds = labels.map((label) => label.id)
  const total = noteIds.length + labelIds.length
  if (total === 0) {
    await repo.clearNotesAndLabels()
    onProgress(100)
    return
  }
  await deleteInBatches(noteIds, (id) => api.deleteNote(id), onProgress, 0, total)
  await deleteInBatches(labelIds, (id) => api.deleteLabel(id), onProgress, noteIds.length, total)
  await repo.clearNotesAndLabels()
  onProgress(100)
}
