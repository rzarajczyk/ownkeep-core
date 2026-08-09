import { CircleAlert, LoaderCircle, Upload, X } from 'lucide-react'
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
    <dialog ref={dialogRef} className="modal" onCancel={(event) => event.preventDefault()}>
      <form className="modal-card" onSubmit={(event) => void submit(event)}>
        <header className="modal-header">
          <h2>{t('import.title')}</h2>
          <button type="button" className="icon-button" onClick={close} aria-label={t('common.actions.close')} disabled={busy}>
            <X />
          </button>
        </header>
        <p>{t('import.description')}</p>
        {!result ? (
          <>
            <label className="file-field">
              <Upload aria-hidden="true" />
              <span>{file ? file.name : t('import.chooseFile')}</span>
              <input
                type="file"
                accept=".zip,application/zip"
                disabled={busy}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {fileError ? <p className="error">{fileError}</p> : null}
            {error ? (
              <p className="error">
                <CircleAlert aria-hidden="true" /> {error}
              </p>
            ) : null}
            {progress !== null ? (
              <p role="status">
                <LoaderCircle className="spin" aria-hidden="true" />{' '}
                {t('import.progress', { progress })}
              </p>
            ) : null}
            <footer className="modal-actions">
              <button type="button" onClick={close} disabled={busy}>
                {t('import.cancel')}
              </button>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? t('import.submitting') : t('import.submit')}
              </button>
            </footer>
          </>
        ) : (
          <>
            <p>
              {t('import.result.imported', { count: result.imported })}
              {result.skipped ? t('import.result.skipped', { count: result.skipped }) : ''}.
            </p>
            {result.warnings.length > 0 ? (
              <ul className="import-warnings">
                {result.warnings.slice(0, 20).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <footer className="modal-actions">
              <button type="button" className="primary" onClick={onClose}>
                {t('import.done')}
              </button>
            </footer>
          </>
        )}
      </form>
    </dialog>
  )
}
