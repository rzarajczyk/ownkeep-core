import { zipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from '../crypto/aead'
import { importKeepZip } from './clientImport'

const api = vi.hoisted(() => ({
  createLabel: vi.fn(),
  createNote: vi.fn(),
  uploadAttachment: vi.fn(),
}))

vi.mock('../api', () => ({ api }))

function keepZip(entries: Record<string, unknown>): File {
  const encoded: Record<string, Uint8Array> = {}
  for (const [path, value] of Object.entries(entries)) {
    encoded[path] = new TextEncoder().encode(JSON.stringify(value))
  }
  const bytes = zipSync(encoded)
  return new File([bytes], 'keep.zip', { type: 'application/zip' })
}

describe('importKeepZip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.createLabel.mockImplementation(async () => ({
      id: crypto.randomUUID(),
      ciphertext: 'label-cipher',
      createdAt: '2026-01-01T00:00:00.000Z',
    }))
    api.createNote.mockResolvedValue({
      id: 'created',
      type: 'TEXT',
      backgroundColor: 'default',
      archived: false,
      pinned: false,
      wrappedNoteKey: 'wrap',
      ciphertext: 'cipher',
      labelIds: [],
      attachments: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    })
  })

  it('imports a Keep JSON note and creates labels', async () => {
    const file = keepZip({
      'Takeout/Keep/Shopping.json': {
        title: 'Shopping',
        textContent: 'Buy milk',
        labels: [{ name: 'Errands' }],
      },
    })
    const result = await importKeepZip(file, randomBytes(32), () => undefined)

    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(0)
    expect(api.createLabel).toHaveBeenCalledOnce()
    expect(api.createNote).toHaveBeenCalledOnce()
    expect(api.createNote.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        type: 'TEXT',
        wrappedNoteKey: expect.any(String),
        ciphertext: expect.any(String),
      }),
    )
  })

  it('skips empty Keep notes', async () => {
    const file = keepZip({
      'Takeout/Keep/Empty.json': {
        title: '',
        textContent: '',
      },
    })
    const result = await importKeepZip(file, randomBytes(32), () => undefined)

    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(1)
    expect(api.createNote).not.toHaveBeenCalled()
  })
})
