import { useRef } from 'react'
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from './types'
import { useAttachmentImageUrls } from './useAttachmentImageUrls'

const api = vi.hoisted(() => ({
  attachmentCipherBlob: vi.fn(),
}))

vi.mock('./api', () => ({ api }))
vi.mock('./notesCipher', () => ({ getCachedNoteKey: () => new Uint8Array(32) }))

const jpegThumb = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)

const attachment: Attachment = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  kind: 'IMAGE',
  originalFilename: 'photo.png',
  mimeType: 'image/png',
  sizeBytes: 12,
  createdAt: '2026-01-01T00:00:00.000Z',
  url: '/attachments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  thumbnail: { mimeType: 'image/jpeg', bytes: jpegThumb },
}

function Preview({ online }: { online: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = `<p><img src="/attachments/${attachment.id}" alt="photo.png"></p>`
  useAttachmentImageUrls(ref, [attachment], html, 'note-1', online)
  return <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
}

describe('useAttachmentImageUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:thumb'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('rewrites markdown images to the thumbnail blob without fetching original bytes', async () => {
    const { container } = render(<Preview online />)
    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb')
    })
    expect(api.attachmentCipherBlob).not.toHaveBeenCalled()
  })

  it('uses the thumbnail while offline', async () => {
    const { container } = render(<Preview online={false} />)
    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb')
    })
    expect(api.attachmentCipherBlob).not.toHaveBeenCalled()
  })
})
