import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { NoteChangeHistory } from './NoteChangeHistory'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: {
      listNoteRevisions: vi.fn(),
      getNoteRevision: vi.fn(),
      updateNoteRevisionLabel: vi.fn(),
    },
  }
})

vi.mock('./revisionSnapshots', () => ({
  decryptRevisionDetail: vi.fn(async () => ({
    noteKey: new Uint8Array(32),
    payload: {
      v: 1,
      title: 'Previous title',
      contentRaw: 'Previous body',
      items: [],
      type: 'TEXT',
      backgroundColor: 'default',
      archived: false,
      pinned: false,
      labelIds: [],
      attachments: [],
    },
  })),
}))

describe('NoteChangeHistory', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    })
    vi.mocked(api.listNoteRevisions).mockResolvedValue({
      items: [
        {
          id: 'revision-1',
          createdAt: '2026-08-10T14:30:00Z',
          sourceVersion: 3,
          labelCiphertext: null,
        },
      ],
      nextCreatedAt: null,
      nextAfterId: null,
      hasMore: false,
    })
    vi.mocked(api.getNoteRevision).mockResolvedValue({
      id: 'revision-1',
      createdAt: '2026-08-10T14:30:00Z',
      sourceVersion: 3,
      labelCiphertext: null,
      wrappedNoteKey: 'wrapped',
      snapshotCiphertext: 'snapshot',
    })
  })

  it('selects a revision from the title and edits the label from the pencil', async () => {
    render(
      <NoteChangeHistory
        noteId="note-1"
        currentVersion={3}
        vaultKey={new Uint8Array(32)}
        open
        onClose={vi.fn()}
        onRestore={vi.fn()}
      />,
    )

    expect(await screen.findByText('Current')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Version from/ }))

    await waitFor(() => {
      expect(api.getNoteRevision).toHaveBeenCalledWith('note-1', 'revision-1', expect.anything())
    })
    expect(screen.queryByRole('textbox', { name: 'Revision label' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Edit “Version from/ }))

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Revision label' })).toBeInTheDocument()
    })
  })
})
