import { useEffect, type RefObject } from 'react'
import { api } from './api'
import { decryptAttachmentBytes } from './crypto/attachmentCodec'
import { attachmentPreviewBlob, imageBlobForDisplay } from './crypto/imageMime'
import { getCachedNoteKey } from './notesCipher'
import type { Attachment } from './types'

const ATTACHMENT_SRC =
  /(?:^|\/)(?:api\/)?attachments\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/i

/**
 * Rewrites authenticated attachment <img> srcs inside a container to thumbnail
 * blob URLs (offline-safe). Original bytes are only fetched for legacy images
 * that have no thumbnail, and never for download.
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
    if (!root || !noteId) return

    const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]))
    const controller = new AbortController()
    const objectUrls: string[] = []
    const bound = new Set<string>()

    const bind = () => {
      root.querySelectorAll('img[src]').forEach((node) => {
        const img = node as HTMLImageElement
        const src = img.getAttribute('src') ?? ''
        if (/^https?:\/\//i.test(src) || src.startsWith('blob:')) return
        const id = src.match(ATTACHMENT_SRC)?.[1]
        if (!id || bound.has(id)) return
        const attachment = byId.get(id)
        if (!attachment) return

        const preview = attachmentPreviewBlob(attachment)
        if (preview) {
          const url = URL.createObjectURL(preview)
          objectUrls.push(url)
          bound.add(id)
          img.src = url
          return
        }

        if (!online) {
          img.removeAttribute('src')
          img.setAttribute('data-offline-attachment', id)
          img.alt = attachment.originalFilename
          return
        }

        const noteKey = getCachedNoteKey(noteId)
        if (!noteKey) return
        bound.add(id)
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
            const url = URL.createObjectURL(imageBlobForDisplay(plain, attachment.mimeType))
            objectUrls.push(url)
            img.src = url
          })
          .catch((reason: unknown) => {
            bound.delete(id)
            if (reason instanceof DOMException && reason.name === 'AbortError') return
          })
      })
    }

    bind()
    const observer = new MutationObserver(bind)
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })

    return () => {
      observer.disconnect()
      controller.abort()
      objectUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [attachments, containerRef, html, noteId, online])
}
