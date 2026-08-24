import { Download, FileText, LoaderCircle, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from './api'
import { decryptAttachmentBytes } from './crypto/attachmentCodec'
import { bytesToBlob } from './crypto/aead'
import { attachmentPreviewBlob, imageBlobForDisplay } from './crypto/imageMime'
import { i18n } from './i18n'
import { getCachedNoteKey } from './notesCipher'
import type { Attachment } from './types'
import { errorMessage, formatBytes } from './utils'
import { Tooltip } from './Tooltip'

interface AttachmentViewProps {
  noteId: string
  attachment: Attachment
  compact?: boolean
  online?: boolean
  onDelete?: (id: string) => Promise<void>
}

async function decryptOriginalBlob(
  noteId: string,
  attachment: Attachment,
  signal?: AbortSignal,
): Promise<Blob> {
  const noteKey = getCachedNoteKey(noteId)
  if (!noteKey) throw new Error(i18n.t('notes.attachment.noteKeyUnavailable'))
  const cipher = await api.attachmentCipherBlob(attachment.id, attachment.url, signal)
  const plain = await decryptAttachmentBytes(
    noteKey,
    attachment.id,
    new Uint8Array(cipher),
  )
  if (attachment.kind === 'IMAGE') return imageBlobForDisplay(plain, attachment.mimeType)
  return bytesToBlob(plain, attachment.mimeType || 'application/octet-stream')
}

export function AttachmentView({
  noteId,
  attachment,
  compact = false,
  online = typeof navigator === 'undefined' ? true : navigator.onLine,
  onDelete,
}: AttachmentViewProps) {
  const { t } = useTranslation()
  const preview = attachmentPreviewBlob(attachment)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(attachment.kind === 'IMAGE' && !preview && online)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (attachment.kind !== 'IMAGE') return
    const thumbnail = attachmentPreviewBlob(attachment)
    if (thumbnail) {
      const url = URL.createObjectURL(thumbnail)
      setObjectUrl(url)
      setLoading(false)
      setError('')
      return () => URL.revokeObjectURL(url)
    }
    if (!online) {
      setLoading(false)
      setObjectUrl(null)
      setError(t('notes.offline.attachmentsRequireConnection'))
      return
    }
    const controller = new AbortController()
    let url: string | null = null
    setLoading(true)
    decryptOriginalBlob(noteId, attachment, controller.signal)
      .then((blob) => {
        url = URL.createObjectURL(blob)
        setObjectUrl(url)
        setError('')
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(errorMessage(reason))
        }
      })
      .finally(() => setLoading(false))
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [attachment, noteId, online, t])

  async function download() {
    if (!online) {
      setError(t('notes.offline.attachmentsRequireConnection'))
      return
    }
    setError('')
    setDownloading(true)
    try {
      const href = URL.createObjectURL(await decryptOriginalBlob(noteId, attachment))
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = attachment.originalFilename
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(href)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setDownloading(false)
    }
  }

  async function remove() {
    if (!onDelete) return
    setDeleting(true)
    setError('')
    try {
      await onDelete(attachment.id)
    } catch (reason) {
      setError(errorMessage(reason))
      setDeleting(false)
    }
  }

  const downloadLabel = t('notes.attachment.download', { filename: attachment.originalFilename })
  const deleteLabel = t('notes.attachment.delete', { filename: attachment.originalFilename })

  if (attachment.kind === 'IMAGE') {
    return (
      <figure className={`attachment-image ${compact ? 'compact' : ''}`}>
        {loading && (
          <span className="attachment-loading">
            <LoaderCircle className="spin" aria-hidden="true" /> {t('notes.attachment.loadingImage')}
          </span>
        )}
        {objectUrl && (
          <img
            src={objectUrl}
            alt={attachment.originalFilename}
            onError={() => setError(t('notes.attachment.unsupportedImage'))}
          />
        )}
        <div className="attachment-image-actions">
          <Tooltip label={downloadLabel}>
            <button
              type="button"
              className="icon-button"
              onClick={(event) => {
                event.stopPropagation()
                void download()
              }}
              disabled={downloading || !online}
              aria-label={downloadLabel}
            >
              {downloading ? <LoaderCircle className="spin" /> : <Download />}
            </button>
          </Tooltip>
          {!compact && onDelete && (
            <Tooltip label={deleteLabel}>
              <button
                type="button"
                className="icon-button danger"
                onClick={remove}
                disabled={deleting}
                aria-label={deleteLabel}
              >
                {deleting ? <LoaderCircle className="spin" /> : <Trash2 />}
              </button>
            </Tooltip>
          )}
        </div>
        {!compact && (
          <figcaption>
            <Tooltip label={attachment.originalFilename}>
              <span>{attachment.originalFilename}</span>
            </Tooltip>
          </figcaption>
        )}
        {error && <span className="field-error">{error}</span>}
      </figure>
    )
  }

  return (
    <div className="attachment-file">
      <FileText aria-hidden="true" />
      <button type="button" className="file-download" onClick={download} disabled={loading || !online}>
        <span>{attachment.originalFilename}</span>
        <small>{formatBytes(attachment.sizeBytes)}</small>
      </button>
      <Tooltip label={downloadLabel}>
        <button
          type="button"
          className="icon-button"
          onClick={download}
          disabled={loading || downloading || !online}
          aria-label={downloadLabel}
        >
          {loading || downloading ? <LoaderCircle className="spin" /> : <Download />}
        </button>
      </Tooltip>
      {!compact && onDelete && (
        <Tooltip label={deleteLabel}>
          <button
            type="button"
            className="icon-button danger"
            onClick={remove}
            disabled={deleting}
            aria-label={deleteLabel}
          >
            {deleting ? <LoaderCircle className="spin" /> : <Trash2 />}
          </button>
        </Tooltip>
      )}
      {error && <span className="field-error">{error}</span>}
    </div>
  )
}
