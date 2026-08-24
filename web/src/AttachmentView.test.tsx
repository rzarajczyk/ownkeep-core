import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from './types'
import { AttachmentView } from './AttachmentView'

const api = vi.hoisted(() => ({
  attachmentCipherBlob: vi.fn(),
}))

const getCachedNoteKey = vi.hoisted(() => vi.fn())
const decryptAttachmentBytes = vi.hoisted(() => vi.fn())

vi.mock('./api', () => ({ api }))
vi.mock('./notesCipher', () => ({ getCachedNoteKey }))
vi.mock('./crypto/attachmentCodec', () => ({ decryptAttachmentBytes }))

const jpegThumb = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)

const imageAttachment: Attachment = {
  id: 'att-1',
  kind: 'IMAGE',
  originalFilename: 'photo.png',
  mimeType: 'image/png',
  sizeBytes: 12,
  createdAt: '2026-01-01T00:00:00.000Z',
  url: '/attachments/att-1',
  metaCiphertext: 'meta',
}

const imageWithThumb: Attachment = {
  ...imageAttachment,
  thumbnail: { mimeType: 'image/jpeg', bytes: jpegThumb },
}

describe('AttachmentView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCachedNoteKey.mockReturnValue(new Uint8Array(32))
    api.attachmentCipherBlob.mockResolvedValue(new ArrayBuffer(8))
    decryptAttachmentBytes.mockResolvedValue(new Uint8Array([1, 2, 3, 4]))
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:attachment'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('shows a stored thumbnail without downloading the original', async () => {
    render(<AttachmentView noteId="note-1" attachment={imageWithThumb} online />)

    expect(await screen.findByRole('img', { name: 'photo.png' })).toHaveAttribute(
      'src',
      'blob:attachment',
    )
    expect(screen.queryByText(/Loading image/i)).not.toBeInTheDocument()
    expect(api.attachmentCipherBlob).not.toHaveBeenCalled()
  })

  it('shows the thumbnail while offline', async () => {
    render(<AttachmentView noteId="note-1" attachment={imageWithThumb} online={false} />)

    expect(await screen.findByRole('img', { name: 'photo.png' })).toHaveAttribute(
      'src',
      'blob:attachment',
    )
    expect(screen.queryByText('Attachments require a connection.')).not.toBeInTheDocument()
    expect(api.attachmentCipherBlob).not.toHaveBeenCalled()
  })

  it('falls back to decrypting the original when no thumbnail is stored', async () => {
    render(<AttachmentView noteId="note-1" attachment={imageAttachment} online />)

    expect(screen.getByText(/Loading image/i)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'photo.png' })).toHaveAttribute(
        'src',
        'blob:attachment',
      )
    })
    expect(api.attachmentCipherBlob).toHaveBeenCalledWith(
      'att-1',
      '/attachments/att-1',
      expect.any(AbortSignal),
    )
  })

  it('shows an offline error for images without a thumbnail', async () => {
    render(<AttachmentView noteId="note-1" attachment={imageAttachment} online={false} />)

    expect(await screen.findByText('Attachments require a connection.')).toBeInTheDocument()
    expect(api.attachmentCipherBlob).not.toHaveBeenCalled()
  })

  it('downloads the original bytes even when a thumbnail is shown', async () => {
    render(<AttachmentView noteId="note-1" attachment={imageWithThumb} online />)
    await screen.findByRole('img', { name: 'photo.png' })

    fireEvent.click(screen.getByRole('button', { name: /Download photo.png/i }))
    await waitFor(() => {
      expect(api.attachmentCipherBlob).toHaveBeenCalledWith(
        'att-1',
        '/attachments/att-1',
        undefined,
      )
    })
  })
})
