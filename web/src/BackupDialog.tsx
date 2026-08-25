import { Download, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { exportBackupZip, type BackupExportResult } from './backup/exportBackup'
import { downloadNoteFile } from './export/download'
import type { LocalRepository } from './offline/repository'
import { useVault } from './vault/VaultContext'
import { errorMessage } from './utils'

interface BackupDialogProps {
  onClose: () => void
  onCompleted: () => void
  repo: LocalRepository
}

export function BackupDialog({ onClose, onCompleted, repo }: BackupDialogProps) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { vaultKey } = useVault()
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<BackupExportResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  function close() {
    if (busy) return
    onClose()
  }

  async function startBackup() {
    setError('')
    if (!vaultKey) {
      setError(t('backup.export.vaultLocked'))
      return
    }
    setBusy(true)
    setProgress(0)
    try {
      const next = await exportBackupZip({
        vaultKey,
        repo,
        onProgress: setProgress,
      })
      downloadNoteFile(next.filename, next.blob)
      setResult(next)
      onCompleted()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="import-dialog"
      aria-labelledby="backup-export-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="import-panel">
        <header className="import-header">
          <div>
            <span className="eyebrow">{t('backup.export.eyebrow')}</span>
            <h2 id="backup-export-title">{t('backup.export.title')}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label={t('common.actions.close')}
            disabled={busy}
          >
            <X />
          </button>
        </header>

        {result ? (
          <div className="import-job" aria-live="polite">
            <div className="import-result completed">
              <strong>
                {t('backup.export.result.ready')}{' '}
                {t('backup.export.result.notes', { count: result.noteCount })}.
              </strong>
            </div>
            {result.warnings.length > 0 ? (
              <details className="import-warnings">
                <summary>
                  {t('backup.export.result.warningsTitle')} ({result.warnings.length})
                </summary>
                <ul>
                  {result.warnings.slice(0, 20).map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            <div className="import-actions">
              <button type="button" className="primary-button" onClick={onClose}>
                {t('backup.export.done')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="backup-warning" role="status">
              {t('backup.export.warning')}
            </p>
            <p>{t('backup.export.description')}</p>
            {progress !== null ? (
              <div className="import-progress" role="status">
                <span>
                  <LoaderCircle className="spin" aria-hidden="true" />{' '}
                  {t('backup.export.progress', { progress })}
                </span>
                <progress max="100" value={progress}>
                  {progress}%
                </progress>
              </div>
            ) : null}
            {error ? (
              <p className="inline-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="import-actions">
              <button type="button" className="secondary-button" onClick={close} disabled={busy}>
                {t('backup.export.cancel')}
              </button>
              <button type="button" className="primary-button" onClick={() => void startBackup()} disabled={busy}>
                {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                {busy ? t('backup.export.submitting') : t('backup.export.submit')}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  )
}
