import { api } from '../api'
import { decryptAttachmentBytes } from '../crypto/attachmentCodec'
import { i18n } from '../i18n'
import { getCachedNoteKey } from '../notesCipher'
import type { Attachment, Note } from '../types'
import { errorMessage } from '../utils'
import type { ExportBinary, ExportFormat } from './types'

export function exportNeedsAttachments(format: ExportFormat, note: Note): 'none' | 'images' | 'all' {
  if (format === 'md' || format === 'txt') return 'none'
  if (format === 'md-zip') return note.attachments.length ? 'all' : 'none'
  return note.attachments.some((attachment) => attachment.kind === 'IMAGE') ? 'images' : 'none'
}

async function decryptOne(noteId: string, attachment: Attachment): Promise<ExportBinary> {
  const noteKey = getCachedNoteKey(noteId)
  if (!noteKey) {
    throw new Error(i18n.t('notes.attachment.noteKeyUnavailable'))
  }
  const cipher = await api.attachmentCipherBlob(attachment.id, attachment.url)
  const bytes = await decryptAttachmentBytes(noteKey, attachment.id, new Uint8Array(cipher))
  return {
    filename: attachment.originalFilename,
    mimeType: attachment.mimeType,
    bytes,
  }
}

export async function loadExportAttachments(
  note: Note,
  includeFiles: boolean,
): Promise<{ images: ExportBinary[]; files: ExportBinary[]; errors: string[] }> {
  const images: ExportBinary[] = []
  const files: ExportBinary[] = []
  const errors: string[] = []

  for (const attachment of note.attachments) {
    const isImage = attachment.kind === 'IMAGE'
    if (!isImage && !includeFiles) continue
    try {
      const loaded = await decryptOne(note.id, attachment)
      if (isImage) images.push(loaded)
      else files.push(loaded)
    } catch (reason) {
      const message = i18n.t('editor.export.attachmentFailed', {
        name: attachment.originalFilename,
        error: errorMessage(reason),
      })
      errors.push(message)
      const placeholder: ExportBinary = {
        filename: attachment.originalFilename,
        mimeType: attachment.mimeType,
        bytes: null,
      }
      if (isImage) images.push(placeholder)
      else if (includeFiles) files.push(placeholder)
    }
  }

  return { images, files, errors }
}
