import { api } from '../api'
import { decryptLabels } from '../notesCipher'
import type { LocalRepository } from '../offline/repository'
import { BACKUP_IMPORT_LABEL_PREFIX, uniqueImportLabelName } from '../keepImport/labels'
import { wipeVaultContent } from '../keepImport/wipeVault'
import type { ImportResult } from '../vaultImport/ingest'
import type { VaultImportMode, VaultImportProgress } from '../vaultImport/types'
import { importBackupZip } from './importBackup'

export async function runBackupImport(options: {
  file: File
  vaultKey: Uint8Array
  mode: VaultImportMode
  repo: LocalRepository
  pauseSync: () => void
  resumeSync: () => void
  onProgress: (progress: VaultImportProgress) => void
}): Promise<ImportResult> {
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
      mode === 'add' ? [uniqueImportLabelName(idToName.values(), new Date(), BACKUP_IMPORT_LABEL_PREFIX)] : []
    return await importBackupZip({
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
