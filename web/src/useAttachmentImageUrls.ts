import { useEffect, type RefObject } from 'react'
import { api } from './api'
import { decryptAttachmentBytes } from './crypto/attachmentCodec'
import { getCachedNoteKey } from './notesCipher'
import type { Attachment } from './types'

const ATTACHMENT_SRC =
  /(?:^|\/)(?:api\/)?attachments\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/i

/**
 * Rewrites authenticated attachment <img> srcs inside a container to blob URLs.
 * External http(s) images are left alone. Safe to reuse from a future editor preview.
 */
export function useAttachmentImageUrls(
  containerRef: RefObject<HTMLElement | null>,
  attachments: Attachment[],
  html: string,
  noteId?: string,
  online = typeof navigator === 'undefined' ? true : navigator.onLine,
) {
  useEffect(() => {
    const root = containerRef.current
    if (!root || !html || !noteId) return

    const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]))
    const controller = new AbortController()
    const objectUrls: string[] = []

    root.querySelectorAll('img[src]').forEach((node) => {
      const img = node as HTMLImageElement
      const src = img.getAttribute('src') ?? ''
      if (/^https?:\/\//i.test(src)) return
      const id = src.match(ATTACHMENT_SRC)?.[1]
      if (!id) return
      const attachment = byId.get(id)
      if (!attachment) return

      if (!online) {
        img.removeAttribute('src')
        img.setAttribute('data-offline-attachment', id)
        img.alt = attachment.originalFilename
        return
      }

      const noteKey = getCachedNoteKey(noteId)
      if (!noteKey) return

      api
        .attachmentCipherBlob(attachment.id, attachment.url, controller.signal)
        .then(async (cipher) => {
          if (controller.signal.aborted) return
          const plain = await decryptAttachmentBytes(
            noteKey,
            attachment.id,
            new Uint8Array(cipher),
          )
          if (controller.signal.aborted) return
          const url = URL.createObjectURL(
            new Blob(
              [plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer],
              { type: attachment.mimeType },
            ),
          )
          objectUrls.push(url)
          img.src = url
        })
        .catch((reason: unknown) => {
          if (reason instanceof DOMException && reason.name === 'AbortError') return
        })
    })

    return () => {
      controller.abort()
      objectUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [attachments, containerRef, html, noteId, online])
}
