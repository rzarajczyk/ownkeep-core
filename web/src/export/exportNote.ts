import { exportNeedsAttachments, loadExportAttachments } from './attachments'
import { buildExportDocument, noteToPlainText } from './document'
import { noteToDocx } from './docx'
import { noteExportBasename } from './filename'
import { noteToHtml } from './html'
import { noteToMarkdown } from './markdown'
import { noteToOdt } from './odt'
import { noteToRtf } from './rtf'
import { bytesToBlob } from './xml'
import { noteToMarkdownZip } from './zip'
import type { Note } from '../types'
import type { ExportFormat } from './types'

export type ExportResult =
  | { kind: 'file'; filename: string; blob: Blob; errors: string[] }
  | { kind: 'print'; html: string; errors: string[] }

export async function exportNote(note: Note, format: ExportFormat): Promise<ExportResult> {
  const basename = noteExportBasename(note.title)
  const need = exportNeedsAttachments(format, note)
  const loaded =
    need === 'none'
      ? { images: [], files: [], errors: [] }
      : await loadExportAttachments(note, need === 'all')
  const { images, files, errors } = loaded
  const doc = buildExportDocument(note)

  switch (format) {
    case 'md':
      return {
        kind: 'file',
        filename: `${basename}.md`,
        blob: new Blob([noteToMarkdown(note)], { type: 'text/markdown;charset=utf-8' }),
        errors,
      }
    case 'txt':
      return {
        kind: 'file',
        filename: `${basename}.txt`,
        blob: new Blob([noteToPlainText(note)], { type: 'text/plain;charset=utf-8' }),
        errors,
      }
    case 'html':
      return {
        kind: 'file',
        filename: `${basename}.html`,
        blob: new Blob([noteToHtml(note, images)], { type: 'text/html;charset=utf-8' }),
        errors,
      }
    case 'print':
      return { kind: 'print', html: noteToHtml(note, images), errors }
    case 'md-zip':
      return {
        kind: 'file',
        filename: `${basename}.zip`,
        blob: bytesToBlob(noteToMarkdownZip(note, basename, images, files), 'application/zip'),
        errors,
      }
    case 'odt':
      return {
        kind: 'file',
        filename: `${basename}.odt`,
        blob: bytesToBlob(noteToOdt(doc, images), 'application/vnd.oasis.opendocument.text'),
        errors,
      }
    case 'docx':
      return {
        kind: 'file',
        filename: `${basename}.docx`,
        blob: bytesToBlob(
          noteToDocx(doc, images),
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
        errors,
      }
    case 'rtf':
      return {
        kind: 'file',
        filename: `${basename}.rtf`,
        blob: new Blob([await noteToRtf(doc, images)], { type: 'application/rtf;charset=utf-8' }),
        errors,
      }
  }
}
