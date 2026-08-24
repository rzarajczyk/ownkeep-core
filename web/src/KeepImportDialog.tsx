import { LoaderCircle, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { runKeepImport, type KeepImportMode, type KeepImportProgress } from './keepImport/runImport'
import type { KeepImportResult } from './keepImport/clientImport'
import type { LocalRepository } from './offline/repository'
import { useVault } from './vault/VaultContext'
import { errorMessage } from './utils'

interface KeepImportDialogProps {
  onClose: () => void
  onCompleted: () => Promise<void>
  repo: LocalRepository
  pauseSync: () => void
  resumeSync: () => void
}

export function KeepImportDialog({
  onClose,
  onCompleted,
  repo,
  pauseSync,
  resumeSync,
}: KeepImportDialogProps) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { vaultKey } = useVault()
  const [step, setStep] = useState<'mode' | 'file'>('mode')
  const [mode, setMode] = useState<KeepImportMode>('add')
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState('')
  const [replaceConfirmed, setReplaceConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<KeepImportProgress | null>(null)
  const [result, setResult] = useState<KeepImportResult | null>(null)
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
    if (mode === 'replace' && !replaceConfirmed) {
      setError(t('import.replaceConfirmRequired'))
      return
    }
    setFileError('')
    setBusy(true)
    setProgress({ phase: mode === 'replace' ? 'clearing' : 'importing', percent: 0 })
    try {
      const next = await runKeepImport({
        file,
        vaultKey,
        mode,
        repo,
        pauseSync,
        resumeSync,
        onProgress: setProgress,
      })
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

        {!result && step === 'mode' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              setStep('file')
            }}
          >
            <p>{t('import.mode.question')}</p>
            <fieldset className="import-modes">
              <legend className="sr-only">{t('import.mode.question')}</legend>
              <label className={`import-mode${mode === 'replace' ? ' selected' : ''}`}>
                <input
                  type="radio"
                  name="import-mode"
                  value="replace"
                  checked={mode === 'replace'}
                  onChange={() => setMode('replace')}
                />
                <span>
                  <strong>{t('import.mode.replace.title')}</strong>
                  <span>{t('import.mode.replace.description')}</span>
                </span>
              </label>
              <label className={`import-mode${mode === 'add' ? ' selected' : ''}`}>
                <input
                  type="radio"
                  name="import-mode"
                  value="add"
                  checked={mode === 'add'}
                  onChange={() => setMode('add')}
                />
                <span>
                  <strong>{t('import.mode.add.title')}</strong>
                  <span>{t('import.mode.add.description')}</span>
                </span>
              </label>
            </fieldset>
            <div className="import-actions">
              <button type="button" className="secondary-button" onClick={close}>
                {t('import.cancel')}
              </button>
              <button type="submit" className="primary-button">
                {t('import.continue')}
              </button>
            </div>
          </form>
        ) : null}

        {!result && step === 'file' ? (
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
            {mode === 'replace' ? (
              <label className="import-confirm">
                <input
                  type="checkbox"
                  checked={replaceConfirmed}
                  disabled={busy}
                  onChange={(event) => setReplaceConfirmed(event.target.checked)}
                />
                <span>{t('import.replaceConfirm')}</span>
              </label>
            ) : null}
            {progress !== null ? (
              <div className="import-progress" role="status">
                <span>
                  <LoaderCircle className="spin" aria-hidden="true" />{' '}
                  {t(`import.progress.${progress.phase}`, { progress: progress.percent })}
                </span>
                <progress max="100" value={progress.percent}>
                  {progress.percent}%
                </progress>
              </div>
            ) : null}
            {error ? (
              <p className="inline-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="import-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  if (busy) return
                  setError('')
                  setStep('mode')
                }}
                disabled={busy}
              >
                {t('import.back')}
              </button>
              <button type="submit" className="primary-button" disabled={busy}>
                {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
                {busy ? t('import.submitting') : t('import.submit')}
              </button>
            </div>
          </form>
        ) : null}

        {result ? (
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
        ) : null}
      </div>
    </dialog>
  )
}
