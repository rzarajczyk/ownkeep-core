import { LoaderCircle, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { importKeepZip } from './keepImport/clientImport'
import { useVault } from './vault/VaultContext'
import { errorMessage } from './utils'

interface KeepImportDialogProps {
  onClose: () => void
  onCompleted: () => Promise<void>
}

export function KeepImportDialog({ onClose, onCompleted }: KeepImportDialogProps) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { vaultKey } = useVault()
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState('')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<{ imported: number; skipped: number; warnings: string[] } | null>(
    null,
  )
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

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (!vaultKey) {
      setError(t('import.vaultLocked'))
      return
    }
    if (!file) {
      setFileError(t('import.noFileSelected'))
      return
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setFileError(t('import.invalidFile'))
      return
    }
    setFileError('')
    setBusy(true)
    setProgress(0)
    try {
      const next = await importKeepZip(file, vaultKey, setProgress)
      setResult(next)
      await onCompleted()
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
      aria-labelledby="keep-import-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="import-panel">
        <header className="import-header">
          <div>
            <span className="eyebrow">{t('import.eyebrow')}</span>
            <h2 id="keep-import-title">{t('import.title')}</h2>
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

        {!result ? (
          <form onSubmit={(event) => void submit(event)}>
            <p>{t('import.description')}</p>
            <label className="import-file">
              <span>{t('import.chooseFile')}</span>
              <input
                type="file"
                accept=".zip,application/zip"
                disabled={busy}
                aria-describedby={fileError ? 'import-file-error' : undefined}
                onChange={(event) => {
                  const selected = event.target.files?.[0] ?? null
                  setFile(selected)
                  setFileError(
                    selected && !selected.name.toLowerCase().endsWith('.zip')
                      ? t('import.invalidFile')
                      : '',
                  )
                }}
              />
            </label>
            {fileError ? (
              <p className="field-error" id="import-file-error">
                {fileError}
              </p>
            ) : null}
            {progress !== null ? (
              <div className="import-progress" role="status">
                <span>
                  <LoaderCircle className="spin" aria-hidden="true" />{' '}
                  {t('import.progress', { progress })}
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
                {t('import.cancel')}
              </button>
              <button type="submit" className="primary-button" disabled={busy}>
                {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
                {busy ? t('import.submitting') : t('import.submit')}
              </button>
            </div>
          </form>
        ) : (
          <div className="import-job" aria-live="polite">
            <div className="import-result completed">
              <strong>
                {t('import.result.imported', { count: result.imported })}
                {result.skipped ? t('import.result.skipped', { count: result.skipped }) : ''}.
              </strong>
            </div>
            {result.warnings.length > 0 ? (
              <details className="import-warnings">
                <summary>
                  {t('import.result.warningsTitle')} ({result.warnings.length})
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
                {t('import.done')}
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  )
}
