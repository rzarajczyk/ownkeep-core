import { api } from '../api'
import { decryptLabels } from '../notesCipher'
import type { LocalRepository } from '../offline/repository'
import { importKeepZip, type KeepImportResult } from './clientImport'
import { uniqueImportLabelName } from './labels'
import { wipeVaultContent } from './wipeVault'

export type KeepImportMode = 'replace' | 'add'

export interface KeepImportProgress {
  phase: 'clearing' | 'importing'
  percent: number
}

export async function runKeepImport(options: {
  file: File
  vaultKey: Uint8Array
  mode: KeepImportMode
  repo: LocalRepository
  pauseSync: () => void
  resumeSync: () => void
  onProgress: (progress: KeepImportProgress) => void
}): Promise<KeepImportResult> {
  const { file, vaultKey, mode, repo, pauseSync, resumeSync, onProgress } = options
  pauseSync()
  try {
    if (mode === 'replace') {
      await wipeVaultContent(repo, (percent) => onProgress({ phase: 'clearing', percent }))
    }
    const wires = mode === 'replace' ? [] : await api.listLabels()
    const idToName = wires.length > 0 ? await decryptLabels(vaultKey, wires) : new Map<string, string>()
    const existingLabels = new Map<string, string>()
    for (const [id, name] of idToName) {
      existingLabels.set(name.toLowerCase(), id)
    }
    const extraLabelNames =
      mode === 'add' ? [uniqueImportLabelName(idToName.values())] : []
    return await importKeepZip({
      file,
      vaultKey,
      repo,
      existingLabels,
      extraLabelNames,
      onProgress: (percent) => onProgress({ phase: 'importing', percent }),
    })
  } finally {
    resumeSync()
  }
}
