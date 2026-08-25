import { useTranslation } from 'react-i18next'
import { runBackupImport } from './backup/runImport'
import type { LocalRepository } from './offline/repository'
import { ZipImportDialog } from './vaultImport/ZipImportDialog'

interface BackupRestoreDialogProps {
  onClose: () => void
  onCompleted: () => Promise<void>
  repo: LocalRepository
  pauseSync: () => void
  resumeSync: () => void
}

export function BackupRestoreDialog(props: BackupRestoreDialogProps) {
  const { t } = useTranslation()
  return (
    <ZipImportDialog
      {...props}
      titleId="backup-restore-title"
      i18nPrefix="backup.restore"
      plaintextWarning={
        <p className="backup-warning" role="status">
          {t('backup.restore.plaintextWarning')}
        </p>
      }
      runImport={runBackupImport}
    />
  )
}
