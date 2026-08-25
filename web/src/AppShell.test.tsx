import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { AppShell } from './AppShell'
import { decryptLabels, fromWire, toWire } from './notesCipher'
import { LocalRepository } from './offline/repository'
import { SyncEngine } from './offline/syncEngine'
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STEP,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from './sidebarWidth'
import type { Note, User, VaultInfo } from './types'

const vault: VaultInfo = {
  kdfSalt: 'aa',
  kdfParams: { alg: 'argon2id', m: 65536, t: 3, p: 1 },
  wrappedVaultKey: 'bb',
  wrappedVaultKeyRecovery: 'cc',
  hasRecoveryKey: true,
  initialized: true,
  needsRecoveryUnlock: false,
}

const vaultKey = new Uint8Array(32)

vi.mock('./api', () => ({
  ApiError: class ApiError extends Error {
    status: number
    code?: string

    constructor(message: string, status: number, code?: string) {
      super(message)
      this.status = status
      this.code = code
    }
  },
  api: {
    notes: vi.fn(),
    listLabels: vi.fn(),
    createLabel: vi.fn(),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    note: vi.fn(),
    createNoteRevision: vi.fn(),
    conflictResolve: vi.fn(),
    deleteNote: vi.fn(),
    deleteLabel: vi.fn(),
    changePassword: vi.fn(),
    deleteAccount: vi.fn(),
    listUsers: vi.fn(),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    resetUserPassword: vi.fn(),
    me: vi.fn(),
  },
}))

vi.mock('./vault/VaultContext', () => ({
  useVault: () => ({
    vaultKey,
    isUnlocked: true,
    unlockWithPassword: vi.fn(),
    unlockWithRecovery: vi.fn(),
    setupVault: vi.fn(),
    rewrapForNewPassword: vi.fn(),
    installPasswordWrap: vi.fn(),
    lock: vi.fn(),
  }),
}))

const plaintextNotes: Note[] = [
  {
    id: 'u1',
    title: 'Grocery list',
    pinned: false,
    archived: false,
    labels: [],
    labelIds: [],
    type: 'TEXT',
    contentRaw: '',
    contentRendered: '',
    backgroundColor: '#fff',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-03T00:00:00Z',
    version: 1,
    items: [],
    attachments: [],
  },
  {
    id: 'p1',
    title: 'Pinned idea',
    pinned: true,
    archived: false,
    labels: [],
    labelIds: [],
    type: 'TEXT',
    contentRaw: '',
    contentRendered: '',
    backgroundColor: '#fff',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    version: 1,
    items: [],
    attachments: [],
  },
  {
    id: 'u2',
    title: 'Random thought',
    pinned: false,
    archived: false,
    labels: [],
    labelIds: [],
    type: 'TEXT',
    contentRaw: '',
    contentRendered: '',
    backgroundColor: '#fff',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    items: [],
    attachments: [],
  },
]

vi.mock('./notesCipher', async () => {
  const actual = await vi.importActual<typeof import('./notesCipher')>('./notesCipher')
  return {
    ...actual,
    fromWire: vi.fn(async (wire: { id: string }) => plaintextNotes.find((note) => note.id === wire.id)!),
    decryptLabels: vi.fn(async () => new Map()),
    toWire: vi.fn(),
    clearNoteKeyCache: vi.fn(),
  }
})

const testUser: User = { id: 1, email: 'rafal@example.com', role: 'USER', vault }
const adminUser: User = { id: 1, email: 'admin@example.com', role: 'ADMIN', vault }

afterEach(cleanup)

describe('pinned notes layout', () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory()
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    vi.mocked(api.notes).mockReset()
    vi.mocked(api.listLabels).mockReset()
    vi.mocked(api.updateNote).mockReset()
    vi.mocked(decryptLabels).mockReset()
    vi.mocked(fromWire).mockReset()
    vi.mocked(toWire).mockReset()
    vi.mocked(fromWire).mockImplementation(
      async (wire: { id: string }) => plaintextNotes.find((note) => note.id === wire.id)!,
    )
    vi.mocked(toWire).mockImplementation(async (id, draft) => ({
      id,
      type: draft.type,
      backgroundColor: draft.backgroundColor,
      archived: draft.archived,
      pinned: draft.pinned,
      wrappedNoteKey: `wrapped-${id}`,
      ciphertext: `cipher-${id}-${draft.backgroundColor}-${draft.archived}`,
      labelIds: draft.labelIds,
      version: draft.version,
      clientUpdatedAt: '2026-01-04T00:00:00Z',
      clientMutationId: `mutation-${id}`,
    }))
    vi.mocked(decryptLabels).mockResolvedValue(new Map())
    vi.mocked(api.listLabels).mockResolvedValue([])
    vi.mocked(api.notes).mockResolvedValue({
      items: plaintextNotes.map((note) => ({
        id: note.id,
        type: note.type,
        backgroundColor: note.backgroundColor,
        archived: note.archived,
        pinned: note.pinned,
        wrappedNoteKey: 'wk',
        ciphertext: 'ct',
        labelIds: [],
        attachments: [],
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        version: note.version,
      })),
      deletedIds: [],
      nextUpdatedAfter: null,
      nextAfterId: null,
      hasMore: false,
    })
    vi.mocked(api.updateNote).mockImplementation(async (id, payload) => {
      const base = plaintextNotes.find((note) => note.id === id) ?? plaintextNotes[0]!
      return {
        id,
        type: payload.type,
        backgroundColor: payload.backgroundColor ?? base.backgroundColor,
        archived: payload.archived ?? base.archived,
        pinned: payload.pinned ?? base.pinned,
        wrappedNoteKey: payload.wrappedNoteKey ?? 'wk',
        ciphertext: payload.ciphertext ?? 'ct',
        labelIds: payload.labelIds ?? base.labelIds,
        attachments: [],
        createdAt: base.createdAt,
        updatedAt: '2026-01-04T00:00:00Z',
        clientUpdatedAt: payload.clientUpdatedAt ?? '2026-01-04T00:00:00Z',
        clientMutationId: payload.clientMutationId ?? null,
        version: base.version + 1,
      }
    })
  })

  it('shows pinned notes in a Pinned section above Others', async () => {
    render(<AppShell user={testUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Pinned' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Others' })).toBeVisible()

    const pinned = screen.getByRole('heading', { name: 'Pinned' }).closest('section')
    const others = screen.getByRole('heading', { name: 'Others' }).closest('section')
    expect(within(pinned!).getByText('Pinned idea')).toBeVisible()
    expect(within(others!).getByText('Grocery list')).toBeVisible()
    expect(within(others!).getByText('Random thought')).toBeVisible()
  })

  it('loads notes for admins', async () => {
    render(<AppShell user={adminUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)
    await waitFor(() => expect(api.notes).toHaveBeenCalled())
    expect(await screen.findByText('Pinned idea')).toBeVisible()
  })

  it('starts sync from the sidebar status instead of a header button', async () => {
    const kick = vi.spyOn(SyncEngine.prototype, 'kick')
    try {
      render(<AppShell user={testUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)

      const status = await screen.findByRole('button', { name: 'Sync notes' })
      expect(status).toHaveClass('sidebar-status')
      await screen.findByText('Pinned idea')
      await waitFor(() => {
        expect(status).toBeEnabled()
        expect(status).toHaveTextContent('Synced')
        expect(kick).toHaveBeenCalled()
      })
      expect(document.querySelector('.sync-button')).not.toBeInTheDocument()

      kick.mockClear()
      fireEvent.click(status)
      expect(kick).toHaveBeenCalled()
    } finally {
      kick.mockRestore()
    }
  })

  it('keeps healthy notes visible when one cached record cannot be decrypted', async () => {
    vi.mocked(fromWire).mockImplementation(async (wire: { id: string }) => {
      if (wire.id === 'corrupt') throw new Error('invalid ciphertext')
      return plaintextNotes.find((note) => note.id === wire.id)!
    })
    const response = await vi.mocked(api.notes)({ limit: 200 })
    const goodWire = response.items[0]!
    vi.mocked(api.notes).mockResolvedValue({
      ...response,
      items: [goodWire, { ...goodWire, id: 'corrupt' }],
    })

    render(<AppShell user={testUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)

    expect(await screen.findByText('Grocery list')).toBeVisible()
    expect(await screen.findByText(/Encrypted notes that could not be opened: 1/)).toBeVisible()
  })

  it('selects across masonry sections, selects the current view, and exits with Escape', async () => {
    render(<AppShell user={testUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)
    await screen.findByText('Pinned idea')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Pinned idea' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Grocery list' }))

    const toolbar = screen.getByRole('toolbar', { name: 'Batch edit selected notes' })
    expect(within(toolbar).getByText('2 selected')).toBeVisible()
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Select all notes in this view' }))

    expect(within(toolbar).getByText('3 selected')).toBeVisible()
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(3)

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() =>
      expect(
        screen.queryByRole('toolbar', { name: 'Batch edit selected notes' }),
      ).not.toBeInTheDocument(),
    )
  })

  it('adds and removes a mixed existing label across selected notes', async () => {
    const labeledGrocery = {
      ...plaintextNotes[0]!,
      labels: ['Work', 'Work'],
      labelIds: ['label-work', 'label-work-copy'],
    }
    const staleRandom = {
      ...plaintextNotes[2]!,
      labelIds: ['deleted-label'],
    }
    vi.mocked(api.listLabels).mockResolvedValue([
      {
        id: 'label-work',
        ciphertext: 'encrypted-work',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'label-work-copy',
        ciphertext: 'encrypted-work-copy',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ])
    vi.mocked(decryptLabels).mockResolvedValue(
      new Map([
        ['label-work', 'Work'],
        ['label-work-copy', 'Work'],
      ]),
    )
    vi.mocked(fromWire).mockImplementation(async (wire: { id: string }) => {
      if (wire.id === labeledGrocery.id) return labeledGrocery
      if (wire.id === staleRandom.id) return staleRandom
      return plaintextNotes.find((note) => note.id === wire.id)!
    })

    render(<AppShell user={testUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)
    await screen.findByText('Grocery list')
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    fireEvent(window, new Event('offline'))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Grocery list' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Random thought' }))
    const toolbar = screen.getByRole('toolbar', { name: 'Batch edit selected notes' })
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Edit labels' }))
    const mixedLabel = screen.getByRole('checkbox', { name: /^Add Work/ })
    expect(mixedLabel).toHaveAttribute('aria-checked', 'mixed')
    fireEvent.click(mixedLabel)

    await waitFor(() =>
      expect(vi.mocked(toWire).mock.calls.some(
        ([id, draft]) =>
          id === 'u2' &&
          draft.labelIds.length === 1 &&
          draft.labelIds[0]?.startsWith('label-work') &&
          !draft.labelIds.includes('deleted-label'),
      )).toBe(true),
    )
    await waitFor(() => expect(toolbar).toHaveAttribute('aria-busy', 'false'))

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Edit labels' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove label' }))
    fireEvent.click(screen.getByRole('button', { name: /^Remove Work/ }))

    await waitFor(() => {
      const removals = vi.mocked(toWire).mock.calls.filter(
        ([id, draft]) =>
          (id === 'u1' || id === 'u2') && draft.labelIds.length === 0,
      )
      expect(removals).toHaveLength(2)
    })
  })

  it('queues full encrypted color and archive updates while offline', async () => {
    render(<AppShell user={testUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)
    await screen.findByText('Pinned idea')

    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    fireEvent(window, new Event('offline'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Pinned idea' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Grocery list' }))

    const toolbar = screen.getByRole('toolbar', { name: 'Batch edit selected notes' })
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Change note color' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yellow' }))

    const repo = new LocalRepository(testUser.id)
    await waitFor(async () => {
      const ops = await repo.listOutbox()
      expect(ops).toHaveLength(2)
      expect(ops.every((op) => op.payload.backgroundColor === '#fff475')).toBe(true)
      const codecInputs = vi.mocked(toWire).mock.calls.filter(
        ([id]) => id === 'p1' || id === 'u1',
      )
      expect(codecInputs).toHaveLength(2)
      expect(codecInputs.every(([, draft]) =>
        draft.metadataOnly !== true &&
        typeof draft.title === 'string' &&
        Array.isArray(draft.items),
      )).toBe(true)
    })

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Archive selected notes' }))
    await waitFor(async () => {
      const ops = await repo.listOutbox()
      expect(ops).toHaveLength(2)
      expect(ops.every((op) => op.payload.archived === true)).toBe(true)
    })
    expect(screen.queryByText('Pinned idea')).not.toBeInTheDocument()
    expect(screen.queryByText('Grocery list')).not.toBeInTheDocument()
    expect(screen.getByText('Random thought')).toBeVisible()
  })

  it('lists backup and import actions after user settings', async () => {
    render(<AppShell user={testUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)
    await screen.findByText('Pinned idea')
    fireEvent.click(document.querySelector('.account-trigger')!)
    const menu = screen.getByRole('menu')
    expect(within(menu).getByRole('separator')).toBeInTheDocument()
    const items = within(menu).getAllByRole('menuitem').map((item) => item.textContent?.replace(/\s+/g, ' ').trim())
    expect(items).toEqual([
      'User settings',
      'Backup notes',
      'Import from backup file',
      'Import from Google Keep',
    ])
  })

  it('keeps manage users with settings before backup actions', async () => {
    render(<AppShell user={adminUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)
    await screen.findByText('Pinned idea')
    fireEvent.click(document.querySelector('.account-trigger')!)
    const items = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.replace(/\s+/g, ' ').trim())
    expect(items).toEqual([
      'User settings',
      'Manage users',
      'Backup notes',
      'Import from backup file',
      'Import from Google Keep',
    ])
  })
})

describe('sidebar labels and width', () => {
  const longLabel = 'Google Keep import 2026-08-24'

  beforeEach(async () => {
    indexedDB = new IDBFactory()
    localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY)
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    vi.mocked(api.notes).mockReset()
    vi.mocked(api.listLabels).mockReset()
    vi.mocked(decryptLabels).mockReset()
    vi.mocked(fromWire).mockReset()
    vi.mocked(fromWire).mockImplementation(
      async (wire: { id: string }) => plaintextNotes.find((note) => note.id === wire.id)!,
    )
    vi.mocked(decryptLabels).mockResolvedValue(new Map([['label-keep', longLabel]]))
    vi.mocked(api.listLabels).mockResolvedValue([
      {
        id: 'label-keep',
        ciphertext: 'encrypted-keep',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ])
    vi.mocked(api.notes).mockResolvedValue({
      items: plaintextNotes.map((note) => ({
        id: note.id,
        type: note.type,
        backgroundColor: note.backgroundColor,
        archived: note.archived,
        pinned: note.pinned,
        wrappedNoteKey: 'wk',
        ciphertext: 'ct',
        labelIds: [],
        attachments: [],
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        version: note.version,
      })),
      deletedIds: [],
      nextUpdatedAfter: null,
      nextAfterId: null,
      hasMore: false,
    })
  })

  afterEach(() => {
    localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY)
  })

  it('renders long labels inside a truncating span', async () => {
    render(<AppShell user={testUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)

    const labelButton = await screen.findByRole('button', { name: longLabel })
    const labelText = labelButton.querySelector('.nav-label')
    expect(labelText).toHaveTextContent(longLabel)
    expect(labelButton).toHaveClass('nav-subitem')
  })

  it('resizes the sidebar with the keyboard and persists the width', async () => {
    render(<AppShell user={testUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)
    await screen.findByRole('button', { name: longLabel })

    const handle = screen.getByRole('separator', { name: 'Resize navigation' })
    const shell = document.querySelector('.app-shell')
    expect(shell).toHaveStyle({ '--sidebar-width': `${SIDEBAR_WIDTH_DEFAULT}px` })

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(shell).toHaveStyle({ '--sidebar-width': `${SIDEBAR_WIDTH_DEFAULT + SIDEBAR_WIDTH_STEP}px` })
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(
      String(SIDEBAR_WIDTH_DEFAULT + SIDEBAR_WIDTH_STEP),
    )

    fireEvent.keyDown(handle, { key: 'Home' })
    expect(shell).toHaveStyle({ '--sidebar-width': `${SIDEBAR_WIDTH_MIN}px` })
    fireEvent.keyDown(handle, { key: 'End' })
    expect(shell).toHaveStyle({ '--sidebar-width': `${SIDEBAR_WIDTH_MAX}px` })
  })

  it('drags the resize handle to change sidebar width', async () => {
    render(<AppShell user={testUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)
    await screen.findByRole('button', { name: longLabel })

    const handle = screen.getByRole('separator', { name: 'Resize navigation' })
    fireEvent.pointerDown(handle, { button: 0, clientX: SIDEBAR_WIDTH_DEFAULT })
    fireEvent.pointerMove(window, { clientX: SIDEBAR_WIDTH_DEFAULT + 50 })
    fireEvent.pointerUp(window)

    expect(document.querySelector('.app-shell')).toHaveStyle({
      '--sidebar-width': `${SIDEBAR_WIDTH_DEFAULT + 50}px`,
    })
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(
      String(SIDEBAR_WIDTH_DEFAULT + 50),
    )
  })

  it('restores a stored sidebar width', async () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '300')
    render(<AppShell user={testUser} onLogout={vi.fn()} onSessionEnded={vi.fn()} />)
    await screen.findByRole('button', { name: longLabel })
    expect(document.querySelector('.app-shell')).toHaveStyle({ '--sidebar-width': '300px' })
  })
})
