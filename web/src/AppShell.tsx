import {
  Archive,
  ChevronDown,
  FileUp,
  KeyRound,
  LoaderCircle,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Settings,
  StickyNote,
  Tag,
  Users,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api } from './api'
import { encryptLabelName } from './crypto/labelCodec'
import { NoteCard } from './NoteCard'
import { NoteEditor } from './NoteEditor'
import { NotesMasonry } from './NotesMasonry'
import { KeepImportDialog } from './KeepImportDialog'
import { UserManagementDialog } from './UserManagementDialog'
import { UserSettingsDialog } from './UserSettingsDialog'
import {
  decryptLabels,
  fromWire,
  toWire,
} from './notesCipher'
import {
  initialNotesState,
  notesReducer,
  selectNotes,
} from './notesReducer'
import { Tooltip } from './Tooltip'
import type { EncryptedNoteWire, Note, User } from './types'
import { errorMessage } from './utils'
import { useVault } from './vault/VaultContext'

interface AppShellProps {
  user: User
  onLogout: () => Promise<void>
  onSessionEnded: () => void
}

interface SyncCursor {
  updatedAfter?: string
  afterId?: string
}

function noteMatchesQuery(note: Note, needle: string): boolean {
  if (note.title.toLowerCase().includes(needle)) return true
  if (note.contentRaw.toLowerCase().includes(needle)) return true
  if (note.labels.some((label) => label.toLowerCase().includes(needle))) return true
  if (note.items.some((item) => item.text.toLowerCase().includes(needle))) return true
  if (note.attachments.some((attachment) => attachment.originalFilename.toLowerCase().includes(needle))) {
    return true
  }
  return false
}

export function AppShell({ user, onLogout, onSessionEnded }: AppShellProps) {
  const { vaultKey } = useVault()
  const [state, dispatch] = useReducer(notesReducer, initialNotesState)
  const [archived, setArchived] = useState(false)
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [pendingNewNoteId, setPendingNewNoteId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Note[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usersOpen, setUsersOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [knownLabels, setKnownLabels] = useState<string[]>([])
  const accountRef = useRef<HTMLDivElement>(null)
  const loaded = useRef(new Set<boolean>())
  const cursors = useRef<Record<string, SyncCursor>>({})
  const loadRequest = useRef(0)
  const labelIdToName = useRef(new Map<string, string>())
  const labelNameToId = useRef(new Map<string, string>())

  const updateSearchNote = useCallback((note: Note) => {
    setSearchResults((results) =>
      results?.map((result) => (result.id === note.id ? note : result)) ?? null,
    )
  }, [])

  const refreshLabelMaps = useCallback(async (key: Uint8Array) => {
    const wires = await api.listLabels()
    const idToName = await decryptLabels(key, wires)
    const nameToId = new Map<string, string>()
    for (const [id, name] of idToName) {
      nameToId.set(name.toLowerCase(), id)
    }
    labelIdToName.current = idToName
    labelNameToId.current = nameToId
    setKnownLabels(
      [...idToName.values()].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      ),
    )
    return idToName
  }, [])

  const resolveLabelId = useCallback(
    async (name: string, key: Uint8Array): Promise<string> => {
      const lookup = name.toLowerCase()
      const existing = labelNameToId.current.get(lookup)
      if (existing) return existing
      const ciphertext = await encryptLabelName(key, name)
      const created = await api.createLabel(ciphertext)
      labelIdToName.current.set(created.id, name)
      labelNameToId.current.set(lookup, created.id)
      setKnownLabels((previous) => {
        const names = new Map(previous.map((label) => [label.toLowerCase(), label]))
        if (!names.has(lookup)) names.set(lookup, name)
        return [...names.values()].sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: 'base' }),
        )
      })
      return created.id
    },
    [],
  )

  const loadNotes = useCallback(
    async (mode: boolean, incremental = false) => {
      if (!vaultKey) return
      const request = ++loadRequest.current
      if (incremental) setSyncing(true)
      else setLoading(true)
      setLoadError('')
      try {
        const allItems: EncryptedNoteWire[] = []
        const deletedIds: string[] = []
        const cursorKey = incremental ? 'all' : String(mode)
        let cursor = incremental ? cursors.current[cursorKey] ?? {} : {}
        let hasMore = true
        while (hasMore) {
          const page = await api.notes({
            archived: incremental ? undefined : mode,
            limit: 100,
            updatedAfter: cursor.updatedAfter,
            afterId: cursor.afterId,
          })
          allItems.push(...page.items)
          deletedIds.push(...page.deletedIds)
          hasMore = page.hasMore
          const nextCursor = {
            updatedAfter: page.nextUpdatedAfter ?? cursor.updatedAfter,
            afterId: page.nextAfterId ?? cursor.afterId,
          }
          if (
            hasMore &&
            nextCursor.updatedAfter === cursor.updatedAfter &&
            nextCursor.afterId === cursor.afterId
          ) {
            break
          }
          cursor = nextCursor
        }
        if (request !== loadRequest.current && !incremental) return
        const labelNames = await refreshLabelMaps(vaultKey)
        const notes = await Promise.all(
          allItems.map((wire) => fromWire(wire, vaultKey, labelNames)),
        )
        if (request !== loadRequest.current && !incremental) return
        dispatch({ type: 'reconcile', notes, deletedIds })
        cursors.current[cursorKey] = cursor
        if (!incremental) loaded.current.add(mode)
      } catch (reason) {
        setLoadError(errorMessage(reason))
      } finally {
        if (request === loadRequest.current || incremental) {
          setLoading(false)
          setSyncing(false)
        }
      }
    },
    [refreshLabelMaps, vaultKey],
  )

  useEffect(() => {
    if (!vaultKey) {
      setLoading(true)
      return
    }
    if (!loaded.current.has(archived)) void loadNotes(archived)
    else setLoading(false)
  }, [archived, loadNotes, vaultKey])

  useEffect(() => {
    if (!vaultKey) return
    const sync = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void loadNotes(archived, true)
      }
    }
    const interval = window.setInterval(sync, 30_000)
    window.addEventListener('online', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('online', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [archived, loadNotes, vaultKey])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setSearchResults(null)
      setSearchError('')
      setSearching(false)
      return
    }
    setSearching(true)
    setSearchError('')
    const timer = window.setTimeout(() => {
      const needle = trimmed.toLowerCase()
      setSearchResults(Object.values(state.byId).filter((note) => noteMatchesQuery(note, needle)))
      setSearching(false)
    }, 300)
    return () => {
      window.clearTimeout(timer)
    }
  }, [query, state.byId])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 4500)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!accountOpen) return
    const closeMenu = (event: MouseEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountOpen(false)
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [accountOpen])

  async function createNote() {
    if (!vaultKey) return
    setCreating(true)
    setLoadError('')
    try {
      const id = crypto.randomUUID()
      const labelIds: string[] = []
      const labels: string[] = []
      if (selectedLabel) {
        labelIds.push(await resolveLabelId(selectedLabel, vaultKey))
        labels.push(selectedLabel)
      }
      const payload = await toWire(
        id,
        {
          type: 'TEXT',
          title: '',
          contentRaw: '',
          backgroundColor: '#ffffff',
          archived: false,
          pinned: false,
          labels,
          labelIds,
          items: [],
        },
        vaultKey,
      )
      const wire = await api.createNote(payload)
      const note = await fromWire(wire, vaultKey, labelIdToName.current)
      dispatch({ type: 'upsert', note })
      setArchived(false)
      setPendingNewNoteId(note.id)
      setSelectedId(note.id)
    } catch (reason) {
      setToast(errorMessage(reason))
    } finally {
      setCreating(false)
    }
  }

  function replaceNote(note: Note) {
    dispatch({ type: 'upsert', note })
    updateSearchNote(note)
  }

  async function toggleArchive(note: Note) {
    const optimistic = { ...note, archived: !note.archived }
    replaceNote(optimistic)
    try {
      const wire = await api.updateNote(note.id, {
        archived: !note.archived,
        version: note.version,
        type: note.type,
      })
      replaceNote({
        ...optimistic,
        archived: wire.archived,
        version: wire.version,
        updatedAt: wire.updatedAt,
      })
      setToast(wire.archived ? 'Note archived' : 'Note restored')
    } catch (reason) {
      replaceNote(note)
      setToast(`${errorMessage(reason)} The note was restored.`)
    }
  }

  async function discardNote(note: Note) {
    dispatch({ type: 'remove', id: note.id })
    setSearchResults((results) => results?.filter((item) => item.id !== note.id) ?? null)
    try {
      await api.deleteNote(note.id)
    } catch (reason) {
      dispatch({ type: 'upsert', note })
      setToast(`${errorMessage(reason)} The note could not be discarded.`)
    }
  }

  async function deleteNote(note: Note) {
    if (!window.confirm('Delete this note permanently?')) return false
    dispatch({ type: 'remove', id: note.id })
    setSearchResults((results) => results?.filter((item) => item.id !== note.id) ?? null)
    try {
      await api.deleteNote(note.id)
      setToast('Note deleted')
      return true
    } catch (reason) {
      dispatch({ type: 'upsert', note })
      setToast(`${errorMessage(reason)} The note was restored.`)
      throw reason
    }
  }

  const visibleNotes = useMemo(() => {
    let notes: Note[]
    if (searchResults !== null) {
      notes = searchResults.filter((note) => note.archived === archived)
    } else {
      notes = selectNotes(state, archived)
    }
    if (selectedLabel) {
      const needle = selectedLabel.toLowerCase()
      notes = notes.filter((note) =>
        note.labels.some((label) => label.toLowerCase() === needle),
      )
    }
    return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned))
  }, [archived, searchResults, selectedLabel, state])

  const pinnedNotes = useMemo(() => visibleNotes.filter((note) => note.pinned), [visibleNotes])
  const otherNotes = useMemo(() => visibleNotes.filter((note) => !note.pinned), [visibleNotes])
  useEffect(() => {
    setKnownLabels((previous) => {
      const names = new Map<string, string>()
      for (const label of previous) {
        names.set(label.toLowerCase(), label)
      }
      let changed = false
      for (const note of Object.values(state.byId)) {
        for (const label of note.labels) {
          const key = label.toLowerCase()
          if (!names.has(key)) {
            names.set(key, label)
            changed = true
          }
        }
      }
      if (!changed && names.size === previous.length) return previous
      return [...names.values()].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      )
    })
  }, [state.byId])

  const selectedNote = selectedId ? state.byId[selectedId] : null
  const waitingForVault = !vaultKey

  function renderNoteCard(note: Note) {
    return (
      <NoteCard
        key={note.id}
        note={note}
        onOpen={(selected) => {
          setPendingNewNoteId(null)
          setSelectedId(selected.id)
        }}
        onArchive={toggleArchive}
        onDelete={deleteNote}
      />
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          type="button"
          className="icon-button mobile-menu"
          onClick={() => setNavOpen((open) => !open)}
          aria-label="Toggle navigation"
          aria-expanded={navOpen}
        >
          <Menu />
        </button>
        <a className="app-brand" href="/" aria-label="OwnKeep notes">
          <span className="brand-mark small" aria-hidden="true">
            <KeyRound />
          </span>
          <span>OwnKeep</span>
        </a>
        <div className="search-box" role="search">
          {searching ? <LoaderCircle className="spin" /> : <Search />}
          <label className="sr-only" htmlFor="note-search">
            Search notes
          </label>
          <input
            id="note-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes"
          />
          {query && (
            <button
              type="button"
              className="icon-button small"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >
              <X />
            </button>
          )}
        </div>
        <Tooltip label="Sync notes">
          <button
            type="button"
            className="icon-button sync-button"
            onClick={() => void loadNotes(archived, true)}
            disabled={syncing || waitingForVault}
            aria-label="Sync notes"
          >
            <RefreshCw className={syncing ? 'spin' : ''} />
          </button>
        </Tooltip>
        <div className="user-menu" ref={accountRef}>
          <button
            type="button"
            className="account-trigger"
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen((open) => !open)}
          >
            <span className="avatar" aria-hidden="true">
              {user.email.slice(0, 1).toUpperCase()}
            </span>
            <span className="user-login">{user.email}</span>
            <ChevronDown aria-hidden="true" />
          </button>
          {accountOpen && (
            <div className="account-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountOpen(false)
                  setSettingsOpen(true)
                }}
              >
                <Settings aria-hidden="true" /> User settings
              </button>
              {user.role === 'ADMIN' && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false)
                    setUsersOpen(true)
                  }}
                >
                  <Users aria-hidden="true" /> Manage users
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountOpen(false)
                  setImportOpen(true)
                }}
              >
                <FileUp aria-hidden="true" /> Import from Google Keep
              </button>
            </div>
          )}
          <button type="button" className="icon-button" onClick={() => void onLogout()} aria-label="Sign out">
            <LogOut />
          </button>
        </div>
      </header>

      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <nav aria-label="Notes">
          <div className="nav-group">
            <button
              type="button"
              className={!archived && !selectedLabel ? 'active' : ''}
              onClick={() => {
                setArchived(false)
                setSelectedLabel(null)
                setNavOpen(false)
              }}
            >
              <StickyNote aria-hidden="true" /> Notes
            </button>
            {knownLabels.length > 0 && (
              <div className="nav-subitems" role="group" aria-label="Labels">
                {knownLabels.map((label) => {
                  const active =
                    !archived &&
                    selectedLabel !== null &&
                    selectedLabel.toLowerCase() === label.toLowerCase()
                  return (
                    <button
                      type="button"
                      key={label}
                      className={`nav-subitem${active ? ' active' : ''}`}
                      onClick={() => {
                        setArchived(false)
                        setSelectedLabel(label)
                        setNavOpen(false)
                      }}
                    >
                      <Tag aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            className={archived ? 'active' : ''}
            onClick={() => {
              setArchived(true)
              setSelectedLabel(null)
              setNavOpen(false)
            }}
          >
            <Archive aria-hidden="true" /> Archive
          </button>
        </nav>
        <div className="mobile-account">
          <div className="mobile-account-bar">
            <span className="avatar" aria-hidden="true">
              {user.email.slice(0, 1).toUpperCase()}
            </span>
            <span className="user-login">{user.email}</span>
            <button type="button" className="icon-button" onClick={() => void onLogout()} aria-label="Sign out">
              <LogOut />
            </button>
          </div>
          <button
            type="button"
            className="mobile-import"
            onClick={() => {
              setNavOpen(false)
              setSettingsOpen(true)
            }}
          >
            <Settings aria-hidden="true" /> User settings
          </button>
          {user.role === 'ADMIN' && (
            <button
              type="button"
              className="mobile-import"
              onClick={() => {
                setNavOpen(false)
                setUsersOpen(true)
              }}
            >
              <Users aria-hidden="true" /> Manage users
            </button>
          )}
          <button
            type="button"
            className="mobile-import"
            onClick={() => {
              setNavOpen(false)
              setImportOpen(true)
            }}
          >
            <FileUp aria-hidden="true" /> Import from Google Keep
          </button>
        </div>
        <p className="sidebar-status">
          <span className={navigator.onLine ? 'online-dot' : 'offline-dot'} />
          {navigator.onLine ? 'Connected' : 'Offline'}
        </p>
      </aside>

      <main className="workspace">
        <div className="workspace-heading">
          <div>
            <span className="eyebrow">{query ? 'Search results' : 'Workspace'}</span>
            <h1>
              {archived
                ? 'Archive'
                : selectedLabel
                  ? selectedLabel
                  : 'Your notes'}
            </h1>
          </div>
          {!archived && (
            <div className="create-actions" aria-label="Create note">
              <button
                type="button"
                className="primary-button"
                onClick={() => void createNote()}
                disabled={creating || waitingForVault}
              >
                {creating ? <LoaderCircle className="spin" /> : <Plus />}
                Add note
              </button>
            </div>
          )}
        </div>

        {searchError && <div className="inline-error" role="alert">{searchError}</div>}
        {loadError && (
          <div className="state-panel error-state" role="alert">
            <h2>Couldn’t load your notes</h2>
            <p>{loadError}</p>
            <button type="button" className="secondary-button" onClick={() => void loadNotes(archived)}>
              <RefreshCw /> Try again
            </button>
          </div>
        )}
        {(waitingForVault || loading) && !loadError && (
          <div className="state-panel" role="status">
            <LoaderCircle className="spin large" />
            <p>Gathering your notes…</p>
          </div>
        )}
        {!waitingForVault && !loading && !loadError && visibleNotes.length === 0 && (
          <div className="state-panel empty-state">
            <span className="empty-icon" aria-hidden="true">
              {archived ? <Archive /> : selectedLabel ? <Tag /> : <StickyNote />}
            </span>
            <h2>
              {query
                ? 'No matching notes'
                : archived
                  ? 'Your archive is empty'
                  : selectedLabel
                    ? `No notes labeled “${selectedLabel}”`
                    : 'A quiet place for your thoughts'}
            </h2>
            <p>
              {query
                ? 'Try a different word or clear your search.'
                : archived
                  ? 'Archived notes will stay safely tucked away here.'
                  : selectedLabel
                    ? 'Create a note or add this label to an existing one.'
                    : 'Create a note to get started.'}
            </p>
            {!archived && !query && (
              <button type="button" className="primary-button" onClick={() => void createNote()}>
                <Plus /> Add note
              </button>
            )}
          </div>
        )}
        {!waitingForVault && !loading && visibleNotes.length > 0 && (
          <div
            className="notes-board"
            aria-label={
              archived
                ? 'Archived notes'
                : selectedLabel
                  ? `Notes labeled ${selectedLabel}`
                  : 'Notes'
            }
          >
            {pinnedNotes.length > 0 && (
              <section className="notes-section" aria-labelledby="pinned-notes-heading">
                <h2 id="pinned-notes-heading" className="notes-section-title">
                  Pinned
                </h2>
                <NotesMasonry notes={pinnedNotes} renderNote={renderNoteCard} />
              </section>
            )}
            {otherNotes.length > 0 && (
              <section
                className="notes-section"
                aria-labelledby={pinnedNotes.length > 0 ? 'other-notes-heading' : undefined}
                aria-label={pinnedNotes.length > 0 ? undefined : archived ? 'Archived notes' : 'Notes'}
              >
                {pinnedNotes.length > 0 && (
                  <h2 id="other-notes-heading" className="notes-section-title">
                    Others
                  </h2>
                )}
                <NotesMasonry notes={otherNotes} renderNote={renderNoteCard} />
              </section>
            )}
          </div>
        )}
      </main>

      {selectedNote && (
        <NoteEditor
          note={selectedNote}
          knownLabels={knownLabels}
          cancelIfEmpty={pendingNewNoteId === selectedNote.id}
          startInEditMode={pendingNewNoteId === selectedNote.id}
          ensureLabelIds={async (names) => {
            if (!vaultKey) throw new Error('Vault is locked')
            const ids: string[] = []
            for (const name of names) {
              ids.push(await resolveLabelId(name, vaultKey))
            }
            return ids
          }}
          onClose={() => {
            setSelectedId(null)
            setPendingNewNoteId(null)
          }}
          onOptimistic={replaceNote}
          onCanonical={replaceNote}
          onDelete={deleteNote}
          onDiscard={discardNote}
        />
      )}
      {importOpen && (
        <KeepImportDialog
          onClose={() => setImportOpen(false)}
          onCompleted={async () => {
            loaded.current.clear()
            cursors.current = {}
            await loadNotes(archived)
            setToast('Google Keep import completed')
          }}
        />
      )}
      {settingsOpen && (
        <UserSettingsDialog
          onClose={() => setSettingsOpen(false)}
          onPasswordChanged={onSessionEnded}
          onAccountDeleted={onSessionEnded}
        />
      )}
      {usersOpen && (
        <UserManagementDialog currentUser={user} onClose={() => setUsersOpen(false)} />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button type="button" className="icon-button small" onClick={() => setToast('')} aria-label="Dismiss message">
            <X />
          </button>
        </div>
      )}
    </div>
  )
}
