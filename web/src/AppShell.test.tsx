import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { AppShell } from './AppShell'
import { fromWire } from './notesCipher'
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
  api: {
    notes: vi.fn(),
    listLabels: vi.fn(),
    createLabel: vi.fn(),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
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
    vi.mocked(api.notes).mockReset()
    vi.mocked(api.listLabels).mockReset()
    vi.mocked(fromWire).mockReset()
    vi.mocked(fromWire).mockImplementation(
      async (wire: { id: string }) => plaintextNotes.find((note) => note.id === wire.id)!,
    )
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
})
