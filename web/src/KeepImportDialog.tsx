import { runKeepImport } from './keepImport/runImport'
import type { LocalRepository } from './offline/repository'
import { ZipImportDialog } from './vaultImport/ZipImportDialog'

interface KeepImportDialogProps {
  onClose: () => void
  onCompleted: () => Promise<void>
  repo: LocalRepository
  pauseSync: () => void
  resumeSync: () => void
}

export function KeepImportDialog(props: KeepImportDialogProps) {
  return <ZipImportDialog {...props} titleId="keep-import-title" i18nPrefix="import" runImport={runKeepImport} />
}
