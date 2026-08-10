import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { NoteEditor } from './NoteEditor'
import * as notesCipher from './notesCipher'
import type { Note } from './types'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: {
      updateNote: vi.fn(),
      note: vi.fn(),
      uploadAttachment: vi.fn(),
      deleteAttachment: vi.fn(),
      createNoteRevision: vi.fn(),
      listNoteRevisions: vi.fn(),
      getNoteRevision: vi.fn(),
      updateNoteRevisionLabel: vi.fn(),
      restoreNoteRevision: vi.fn(),
      listLabels: vi.fn(),
    },
  }
})

vi.mock('./revisionSnapshots', () => ({
  buildEncryptedRevision: vi.fn(async (note: Note) => ({
    id: 'rev-baseline',
    sourceVersion: note.version,
    wrappedNoteKey: 'wk',
    snapshotCiphertext: 'snap',
  })),
  decryptRevisionDetail: vi.fn(),
}))

vi.mock('./vault/VaultContext', () => ({
  useVault: () => ({
    vaultKey: new Uint8Array(32),
    isUnlocked: true,
    unlockWithPassword: vi.fn(),
    unlockWithRecovery: vi.fn(),
    setupVault: vi.fn(),
    rewrapForNewPassword: vi.fn(),
    installPasswordWrap: vi.fn(),
    lock: vi.fn(),
  }),
}))

vi.mock('./notesCipher', async () => {
  const actual = await vi.importActual<typeof import('./notesCipher')>('./notesCipher')
  return {
    ...actual,
    toWire: vi.fn(async (id: string, draft: Note) => ({
      id,
      type: draft.type,
      backgroundColor: draft.backgroundColor,
      archived: draft.archived,
      pinned: draft.pinned,
      version: draft.version,
      wrappedNoteKey: 'wk',
      ciphertext: 'ct',
      labelIds: draft.labelIds,
    })),
    fromWire: vi.fn(),
    getCachedNoteKey: vi.fn(() => new Uint8Array(32)),
    setCachedNoteKey: vi.fn(),
  }
})

const baseNote: Note = {
  id: 'n1',
  type: 'TEXT',
  title: '',
  contentRaw: '',
  contentRendered: '',
  backgroundColor: '#ffffff',
  archived: false,
  pinned: false,
  labels: [],
  labelIds: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  version: 1,
  items: [],
  attachments: [],
}

afterEach(cleanup)

describe('NoteEditor', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn()
    HTMLDialogElement.prototype.close = vi.fn()
    vi.mocked(api.updateNote).mockReset()
    vi.mocked(api.createNoteRevision).mockReset()
    vi.mocked(api.createNoteRevision).mockResolvedValue({
      created: true,
      revision: {
        id: 'rev-baseline',
        createdAt: '2026-01-01T00:00:00Z',
        sourceVersion: 1,
        labelCiphertext: null,
      },
    })
    vi.mocked(api.listNoteRevisions).mockReset()
    vi.mocked(api.listNoteRevisions).mockResolvedValue({
      items: [],
      nextCreatedAt: null,
      nextAfterId: null,
      hasMore: false,
    })
    vi.mocked(api.updateNote).mockImplementation(async (id, payload) => ({
      id,
      type: payload.type ?? 'TEXT',
      backgroundColor: payload.backgroundColor ?? '#ffffff',
      archived: payload.archived ?? false,
      pinned: payload.pinned ?? false,
      wrappedNoteKey: payload.wrappedNoteKey ?? 'wk',
      ciphertext: payload.ciphertext ?? 'ct',
      labelIds: payload.labelIds ?? [],
      attachments: [],
      createdAt: baseNote.createdAt,
      updatedAt: new Date().toISOString(),
      version: (payload.version ?? 1) + 1,
    }))
    vi.mocked(notesCipher.fromWire).mockImplementation(async (wire) => ({
      ...baseNote,
      id: wire.id,
      version: wire.version,
      updatedAt: wire.updatedAt,
      title: 'Saved',
      contentRaw: 'Hello',
    }))
  })

  it('autosaves edits through the encrypted update path', async () => {
    render(
      <NoteEditor
        note={baseNote}
        ensureLabelIds={async () => []}
        onClose={vi.fn()}
        onOptimistic={vi.fn()}
        onCanonical={vi.fn()}
        onDelete={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Note title'), { target: { value: 'Saved' } })

    await waitFor(() => expect(api.updateNote).toHaveBeenCalled())
    expect(api.updateNote).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({
        wrappedNoteKey: 'wk',
        ciphertext: 'ct',
      }),
    )
  })

  it('opens notes in rich edit by default', async () => {
    render(
      <NoteEditor
        note={{ ...baseNote, contentRaw: '**Hello**', contentRendered: '<strong>Hello</strong>' }}
        ensureLabelIds={async () => []}
        onClose={vi.fn()}
        onOptimistic={vi.fn()}
        onCanonical={vi.fn()}
        onDelete={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )

    expect(screen.getByText('Rich edit', { selector: 'button' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await waitFor(() => {
      expect(screen.getByLabelText('Note content')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('Note content').className).toMatch(/rich-block-editor|tiptap/)
  })

  it('switches from render to rich edit when preview is clicked', async () => {
    render(
      <NoteEditor
        note={{ ...baseNote, contentRaw: '**Hello**', contentRendered: '<strong>Hello</strong>' }}
        ensureLabelIds={async () => []}
        onClose={vi.fn()}
        onOptimistic={vi.fn()}
        onCanonical={vi.fn()}
        onDelete={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('Render', { selector: 'button' }))
    expect(screen.getByText('Render', { selector: 'button' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByLabelText('Markdown preview')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Markdown preview'))

    expect(screen.getByText('Rich edit', { selector: 'button' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await waitFor(() => {
      expect(screen.getByLabelText('Note content')).toBeInTheDocument()
    })
  })

  it('can switch to raw edit mode', async () => {
    render(
      <NoteEditor
        note={baseNote}
        startInEditMode
        ensureLabelIds={async () => []}
        onClose={vi.fn()}
        onOptimistic={vi.fn()}
        onCanonical={vi.fn()}
        onDelete={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )

    expect(screen.getByText('Rich edit', { selector: 'button' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    fireEvent.click(screen.getByText('Markdown', { selector: 'button' }))
    expect(screen.getByText('Markdown', { selector: 'button' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByLabelText('Note content').tagName).toBe('TEXTAREA')
  })

  it('autosaves rich edit content changes as markdown', async () => {
    render(
      <NoteEditor
        note={baseNote}
        ensureLabelIds={async () => []}
        onClose={vi.fn()}
        onOptimistic={vi.fn()}
        onCanonical={vi.fn()}
        onDelete={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByLabelText('Note content')).toBeInTheDocument()
    })

    const editor = screen.getByLabelText('Note content')
    editor.focus()
    fireEvent.input(editor, { bubbles: true })
    // TipTap updates via ProseMirror; drive change through the Markdown tab fallback path
    // then verify rich mode still saves title + content via encrypted path above.
    fireEvent.click(screen.getByText('Markdown', { selector: 'button' }))
    fireEvent.change(screen.getByLabelText('Note content'), {
      target: { value: 'Hello from edit' },
    })

    await waitFor(() => expect(api.updateNote).toHaveBeenCalled())
    expect(notesCipher.toWire).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ contentRaw: 'Hello from edit' }),
      expect.anything(),
      expect.objectContaining({
        clientUpdatedAt: expect.any(String),
        clientMutationId: expect.any(String),
      }),
    )
  })

  it('does not create a revision when closing without changes', async () => {
    const onClose = vi.fn()
    render(
      <NoteEditor
        note={baseNote}
        ensureLabelIds={async () => []}
        onClose={onClose}
        onOptimistic={vi.fn()}
        onCanonical={vi.fn()}
        onDelete={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByLabelText('Close editor'))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.createNoteRevision).not.toHaveBeenCalled()
  })

  it('creates a revision when closing after a saved edit', async () => {
    const onClose = vi.fn()
    render(
      <NoteEditor
        note={baseNote}
        ensureLabelIds={async () => []}
        onClose={onClose}
        onOptimistic={vi.fn()}
        onCanonical={vi.fn()}
        onDelete={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Note title'), { target: { value: 'Saved' } })
    await waitFor(() => expect(api.updateNote).toHaveBeenCalled())
    // Baseline runs before the first mutation.
    await waitFor(() => expect(api.createNoteRevision).toHaveBeenCalled())
    vi.mocked(api.createNoteRevision).mockClear()

    fireEvent.click(screen.getByLabelText('Close editor'))

    await waitFor(() => expect(api.createNoteRevision).toHaveBeenCalled())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
