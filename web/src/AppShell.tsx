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
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from './api'
import { BatchSelectionToolbar } from './BatchSelectionToolbar'
import { encryptLabelName } from './crypto/labelCodec'
import { NoteCard } from './NoteCard'
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
import { newMutationId, nowIso } from './offline/lww'
import { LocalRepository } from './offline/repository'
import { SyncEngine, wireFromWrite } from './offline/syncEngine'
import type { StoredNoteRecord, SyncStatus } from './offline/types'
import { useOnline } from './offline/useOnline'
import { Tooltip } from './Tooltip'
import type { CreateNoteRevisionRequest, EncryptedNoteWrite, Note, User } from './types'
import { errorMessage, noteToWrite } from './utils'
import { useVault } from './vault/VaultContext'

const NoteEditor = lazy(() =>
  import('./NoteEditor').then((module) => ({ default: module.NoteEditor })),
)

interface AppShellProps {
  user: User
  onLogout: () => Promise<void>
  onSessionEnded: () => void
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

async function decryptStoredNotes(
  records: StoredNoteRecord[],
  vaultKey: Uint8Array,
  labelNames: Map<string, string>,
): Promise<{ notes: Note[]; failedCount: number }> {
  const settled = await Promise.allSettled(
    records.map((record) => fromWire(record.wire, vaultKey, labelNames)),
  )
  return {
    notes: settled
      .filter((result): result is PromiseFulfilledResult<Note> => result.status === 'fulfilled')
      .map((result) => result.value),
    failedCount: settled.filter((result) => result.status === 'rejected').length,
  }
}

function syncStatusLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  status: SyncStatus,
): string {
  switch (status.kind) {
    case 'offline':
      return t('common.status.offline')
    case 'syncing':
      return t('common.status.syncing')
    case 'pending':
      return t('common.status.pending', { count: status.pendingCount })
    case 'error':
      return t('common.status.syncError')
    default:
      return t('common.status.synced')
  }
}

export function AppShell({ user, onLogout, onSessionEnded }: AppShellProps) {
  const { t } = useTranslation()
  const { vaultKey } = useVault()
  const online = useOnline()
  const repoRef = useRef(new LocalRepository(user.id))
  const engineRef = useRef<SyncEngine | null>(null)
  const [state, dispatch] = useReducer(notesReducer, initialNotesState)
  const [archived, setArchived] = useState(false)
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    kind: online ? 'synced' : 'offline',
    pendingCount: 0,
    lastError: null,
    lastSyncedAt: null,
  })
  const [creating, setCreating] = useState(false)
  const [pendingNewNoteId, setPendingNewNoteId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set())
  const [batchBusy, setBatchBusy] = useState(false)
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
  const hydrated = useRef(false)
  const labelIdToName = useRef(new Map<string, string>())
  const labelNameToId = useRef(new Map<string, string>())

  const updateSearchNote = useCallback((note: Note) => {
    setSearchResults((results) =>
      results?.map((result) => (result.id === note.id ? note : result)) ?? null,
    )
  }, [])

  const refreshLabelMaps = useCallback(async (key: Uint8Array) => {
    try {
      const wires = await api.listLabels()
      await repoRef.current.cacheLabels(wires)
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
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'connection_failed')) throw error
      const cached = await repoRef.current.getCachedLabels()
      const idToName = await decryptLabels(key, cached)
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
    }
  }, [])

  const resolveLabelId = useCallback(
    async (name: string, key: Uint8Array): Promise<string> => {
      if (!navigator.onLine) {
        throw new Error(t('notes.offline.requiresConnection'))
      }
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
    [t],
  )

  const hydrateFromLocal = useCallback(async () => {
    if (!vaultKey) return
    setLoading(true)
    setLoadError('')
    try {
      const labelNames = await refreshLabelMaps(vaultKey)
      const records = await repoRef.current.listNotes()
      const { notes, failedCount } = await decryptStoredNotes(records, vaultKey, labelNames)
      dispatch({ type: 'replace', notes })
      hydrated.current = true
      if (failedCount > 0) {
        setLoadError(t('notes.offline.corruptRecords', { count: failedCount }))
      } else if (records.length === 0 && !navigator.onLine) {
        setLoadError(t('notes.offline.coldStart'))
      }
    } catch (reason) {
      setLoadError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [refreshLabelMaps, t, vaultKey])

  const persistLocalWrite = useCallback(
    async (
      noteId: string,
      write: EncryptedNoteWrite,
      draft: Note,
      baselineRevision?: CreateNoteRevisionRequest | null,
      kickSync = true,
    ) => {
      if (!vaultKey) throw new Error(t('errors.vaultLocked'))
      const previous = await repoRef.current.getNote(noteId)
      const wire = wireFromWrite(write, previous?.wire, noteId)
      await repoRef.current.upsertLocalNote(wire, write, {
        neverSynced: previous?.neverSynced ?? !previous,
        baselineRevision,
      })
      const labelMap = new Map(labelIdToName.current)
      for (let i = 0; i < draft.labelIds.length; i += 1) {
        labelMap.set(draft.labelIds[i]!, draft.labels[i] ?? draft.labelIds[i]!)
      }
      const localNote: Note = {
        ...draft,
        updatedAt: wire.updatedAt,
        clientUpdatedAt: wire.clientUpdatedAt,
        clientMutationId: wire.clientMutationId,
        wrappedNoteKey: wire.wrappedNoteKey,
        ciphertext: wire.ciphertext,
      }
      dispatch({ type: 'upsert', note: localNote })
      updateSearchNote(localNote)
      if (kickSync) engineRef.current?.kick()
      return localNote
    },
    [t, updateSearchNote, vaultKey],
  )

  useEffect(() => {
    if (!vaultKey) {
      setLoading(true)
      return
    }
    void hydrateFromLocal()
  }, [hydrateFromLocal, vaultKey])

  useEffect(() => {
    if (!vaultKey) return
    const refreshFromRepo = () => {
      void (async () => {
        if (!vaultKey) return
        try {
          const labelNames = await refreshLabelMaps(vaultKey)
          const records = await repoRef.current.listNotes()
          const { notes, failedCount } = await decryptStoredNotes(records, vaultKey, labelNames)
          dispatch({ type: 'replace', notes })
          setLoadError(
            failedCount > 0
              ? t('notes.offline.corruptRecords', { count: failedCount })
              : '',
          )
        } catch {
          // Keep current UI if refresh fails.
        }
      })()
    }
    const engine = new SyncEngine(repoRef.current, refreshFromRepo)
    engine.setVaultKey(vaultKey)
    engineRef.current = engine
    const unsubscribe = engine.subscribe(setSyncStatus)
    engine.start()
    window.addEventListener('online', refreshFromRepo)
    return () => {
      engine.stop()
      unsubscribe()
      window.removeEventListener('online', refreshFromRepo)
      engineRef.current = null
    }
  }, [refreshLabelMaps, t, vaultKey])

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
        if (!online) {
          throw new Error(t('notes.offline.requiresConnection'))
        }
        labelIds.push(await resolveLabelId(selectedLabel, vaultKey))
        labels.push(selectedLabel)
      }
      const clientUpdatedAt = nowIso()
      const clientMutationId = newMutationId()
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
        { clientUpdatedAt, clientMutationId },
      )
      const wire = wireFromWrite(payload, undefined, id)
      await repoRef.current.upsertLocalNote(wire, payload, { neverSynced: true })
      const note = await fromWire(wire, vaultKey, labelIdToName.current)
      dispatch({ type: 'upsert', note })
      setArchived(false)
      setPendingNewNoteId(note.id)
      setSelectedId(note.id)
      engineRef.current?.kick()
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

  const clearNoteSelection = useCallback(() => {
    setSelectedNoteIds((current) => {
      const focusId = current.values().next().value
      if (focusId) {
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`[data-note-id="${focusId}"]`)?.focus()
        })
      }
      return new Set()
    })
  }, [])

  function setNoteSelected(note: Note, selected: boolean) {
    setSelectedNoteIds((current) => {
      const next = new Set(current)
      if (selected) next.add(note.id)
      else next.delete(note.id)
      return next
    })
  }

  function normalizeKnownLabels(note: Note): Note {
    const labelIds: string[] = []
    const labels: string[] = []
    const seenIds = new Set<string>()
    const seenNames = new Set<string>()
    for (const id of note.labelIds) {
      const label = labelIdToName.current.get(id)
      const lookup = label?.toLowerCase()
      if (!label || !lookup || seenIds.has(id) || seenNames.has(lookup)) continue
      seenIds.add(id)
      seenNames.add(lookup)
      labelIds.push(id)
      labels.push(label)
    }
    return {
      ...note,
      labelIds,
      labels,
    }
  }

  async function persistUpdatedNote(note: Note, updated: Note, kickSync = true) {
    if (!vaultKey) throw new Error(t('errors.vaultLocked'))
    const normalized = normalizeKnownLabels(updated)
    const clientUpdatedAt = nowIso()
    const clientMutationId = newMutationId()
    const payload = await toWire(
      note.id,
      {
        ...noteToWrite(normalized),
        type: normalized.type,
        title: normalized.title,
        contentRaw: normalized.contentRaw,
        items: normalized.items,
        labelIds: normalized.labelIds,
        backgroundColor: normalized.backgroundColor,
        archived: normalized.archived,
        pinned: normalized.pinned,
      },
      vaultKey,
      {
        clientUpdatedAt,
        clientMutationId,
      },
    )
    return persistLocalWrite(note.id, payload, normalized, null, kickSync)
  }

  async function applyBatchUpdates(
    transform: (note: Note) => Note | null,
    successMessage: (count: number) => string,
    clearAfterSuccess = false,
  ) {
    if (batchBusy) return
    const originals = [...selectedNoteIds]
      .map((id) => state.byId[id])
      .filter((note): note is Note => Boolean(note))
    const updates = originals
      .map((note) => ({ note, updated: transform(note) }))
      .filter((entry): entry is { note: Note; updated: Note } => entry.updated !== null)
    if (updates.length === 0) return

    setBatchBusy(true)
    const failedIds = new Set<string>()
    let nextIndex = 0
    const workers = Array.from(
      { length: Math.min(4, updates.length) },
      async () => {
        while (nextIndex < updates.length) {
          const entry = updates[nextIndex]
          nextIndex += 1
          if (!entry) continue
          replaceNote(entry.updated)
          try {
            await persistUpdatedNote(entry.note, entry.updated, false)
          } catch {
            failedIds.add(entry.note.id)
            replaceNote(entry.note)
          }
        }
      },
    )

    try {
      await Promise.all(workers)
      engineRef.current?.kick()
      if (failedIds.size > 0) {
        setSelectedNoteIds((current) => {
          const next = new Set(current)
          for (const id of failedIds) next.add(id)
          return next
        })
        setToast(
          t('notes.batch.partialFailure', {
            succeeded: updates.length - failedIds.size,
            failed: failedIds.size,
          }),
        )
      } else {
        setToast(successMessage(updates.length))
        if (clearAfterSuccess) clearNoteSelection()
      }
    } finally {
      setBatchBusy(false)
    }
  }

  async function applyBatchColor(color: string) {
    await applyBatchUpdates(
      (note) =>
        note.backgroundColor === color ? null : { ...note, backgroundColor: color },
      (count) => t('notes.batch.colorApplied', { count }),
    )
  }

  async function addBatchLabel(label: string) {
    const lookup = label.toLowerCase()
    const matchingLabelIds = new Set(
      [...labelIdToName.current]
        .filter(([, name]) => name.toLowerCase() === lookup)
        .map(([id]) => id),
    )
    const labelId = labelNameToId.current.get(lookup)
    if (!labelId) {
      setToast(t('notes.batch.labelUnavailable'))
      return
    }
    await applyBatchUpdates(
      (note) => {
        if (
          note.labels.some((candidate) => candidate.toLowerCase() === lookup) ||
          note.labelIds.some((id) => matchingLabelIds.has(id))
        ) {
          return null
        }
        return {
          ...note,
          labels: [...note.labels, label],
          labelIds: [...note.labelIds, labelId],
        }
      },
      (count) => t('notes.batch.labelAdded', { count, label }),
    )
  }

  async function removeBatchLabel(label: string) {
    const lookup = label.toLowerCase()
    const matchingLabelIds = new Set(
      [...labelIdToName.current]
        .filter(([, name]) => name.toLowerCase() === lookup)
        .map(([id]) => id),
    )
    await applyBatchUpdates(
      (note) => {
        const hasName = note.labels.some(
          (candidate) => candidate.toLowerCase() === lookup,
        )
        const hasId = note.labelIds.some((id) => matchingLabelIds.has(id))
        if (!hasName && !hasId) return null
        return {
          ...note,
          labels: note.labels.filter((candidate) => candidate.toLowerCase() !== lookup),
          labelIds: note.labelIds.filter((id) => !matchingLabelIds.has(id)),
        }
      },
      (count) => t('notes.batch.labelRemoved', { count, label }),
    )
  }

  async function archiveSelectedNotes() {
    await applyBatchUpdates(
      (note) => ({ ...note, archived: !archived }),
      (count) =>
        archived
          ? t('notes.batch.notesRestored', { count })
          : t('notes.batch.notesArchived', { count }),
      true,
    )
  }

  async function toggleArchive(note: Note) {
    const optimistic = { ...note, archived: !note.archived }
    replaceNote(optimistic)
    try {
      await persistUpdatedNote(note, optimistic)
      setToast(optimistic.archived ? t('notes.toasts.archived') : t('notes.toasts.restored'))
    } catch (reason) {
      replaceNote(note)
      setToast(t('notes.toasts.restoredAfterArchiveError', { error: errorMessage(reason) }))
    }
  }

  async function discardNote(note: Note) {
    if (!online) {
      setToast(t('notes.offline.requiresConnection'))
      return
    }
    dispatch({ type: 'remove', id: note.id })
    setSearchResults((results) => results?.filter((item) => item.id !== note.id) ?? null)
    try {
      await api.deleteNote(note.id)
    } catch (reason) {
      dispatch({ type: 'upsert', note })
      setToast(t('notes.toasts.restoredAfterDiscardError', { error: errorMessage(reason) }))
    }
  }

  async function deleteNote(note: Note) {
    if (!online) {
      setToast(t('notes.offline.requiresConnection'))
      return false
    }
    if (!window.confirm(t('notes.deleteConfirm'))) return false
    dispatch({ type: 'remove', id: note.id })
    setSearchResults((results) => results?.filter((item) => item.id !== note.id) ?? null)
    try {
      await api.deleteNote(note.id)
      setToast(t('notes.toasts.deleted'))
      return true
    } catch (reason) {
      dispatch({ type: 'upsert', note })
      setToast(t('notes.toasts.restoredAfterDeleteError', { error: errorMessage(reason) }))
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
  const selectedBatchNotes = useMemo(
    () => visibleNotes.filter((note) => selectedNoteIds.has(note.id)),
    [selectedNoteIds, visibleNotes],
  )
  const selectionMode = selectedNoteIds.size > 0
  const allVisibleSelected =
    visibleNotes.length > 0 && visibleNotes.every((note) => selectedNoteIds.has(note.id))

  function toggleSelectAll() {
    if (allVisibleSelected) {
      clearNoteSelection()
      return
    }
    setSelectedNoteIds(new Set(visibleNotes.map((note) => note.id)))
  }

  useEffect(() => {
    const visibleIds = new Set(visibleNotes.map((note) => note.id))
    setSelectedNoteIds((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)))
      if (next.size === current.size) return current
      return next
    })
  }, [visibleNotes])

  useEffect(() => {
    if (!selectionMode) return
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || batchBusy) return
      clearNoteSelection()
    }
    document.addEventListener('keydown', exitOnEscape)
    return () => document.removeEventListener('keydown', exitOnEscape)
  }, [batchBusy, clearNoteSelection, selectionMode])

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
        selectionMode={selectionMode}
        selected={selectedNoteIds.has(note.id)}
        onSelectionChange={setNoteSelected}
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
      <header className={`topbar${selectionMode ? ' has-selection' : ''}`}>
        {selectionMode && (
          <BatchSelectionToolbar
            selectedNotes={selectedBatchNotes}
            visibleCount={visibleNotes.length}
            allVisibleSelected={allVisibleSelected}
            archived={archived}
            busy={batchBusy}
            knownLabels={knownLabels}
            onClear={clearNoteSelection}
            onToggleAll={toggleSelectAll}
            onApplyColor={applyBatchColor}
            onAddLabel={addBatchLabel}
            onRemoveLabel={removeBatchLabel}
            onArchive={archiveSelectedNotes}
          />
        )}
        <button
          type="button"
          className="icon-button mobile-menu"
          onClick={() => setNavOpen((open) => !open)}
          aria-label={t('shell.toggleNav')}
          aria-expanded={navOpen}
        >
          <Menu />
        </button>
        <a className="app-brand" href="/" aria-label={t('shell.brand')}>
          <span className="brand-mark small" aria-hidden="true">
            <KeyRound />
          </span>
          <span>{t('common.appName')}</span>
        </a>
        <div className="search-box" role="search">
          {searching ? <LoaderCircle className="spin" /> : <Search />}
          <label className="sr-only" htmlFor="note-search">
            {t('shell.search.label')}
          </label>
          <input
            id="note-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('shell.search.placeholder')}
          />
          {query && (
            <button
              type="button"
              className="icon-button small"
              onClick={() => setQuery('')}
              aria-label={t('shell.search.clear')}
            >
              <X />
            </button>
          )}
        </div>
        <Tooltip label={t('shell.sync')}>
          <button
            type="button"
            className="icon-button sync-button"
            onClick={() => engineRef.current?.kick()}
            disabled={syncStatus.kind === 'syncing' || waitingForVault || !online}
            aria-label={t('shell.sync')}
          >
            <RefreshCw className={syncStatus.kind === 'syncing' ? 'spin' : ''} />
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
                <Settings aria-hidden="true" /> {t('shell.account.userSettings')}
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
                  <Users aria-hidden="true" /> {t('shell.account.manageUsers')}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                disabled={!online}
                onClick={() => {
                  if (!online) return
                  setAccountOpen(false)
                  setImportOpen(true)
                }}
              >
                <FileUp aria-hidden="true" /> {t('shell.account.importFromKeep')}
              </button>
            </div>
          )}
          <button type="button" className="icon-button" onClick={() => void onLogout()} aria-label={t('common.actions.signOut')}>
            <LogOut />
          </button>
        </div>
      </header>

      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <nav aria-label={t('shell.nav.notes')}>
          <div className="nav-group">
            <button
              type="button"
              className={!archived && !selectedLabel ? 'active' : ''}
              onClick={() => {
                clearNoteSelection()
                setArchived(false)
                setSelectedLabel(null)
                setNavOpen(false)
              }}
            >
              <StickyNote aria-hidden="true" /> {t('shell.nav.notes')}
            </button>
            {knownLabels.length > 0 && (
              <div className="nav-subitems" role="group" aria-label={t('shell.nav.labels')}>
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
                        clearNoteSelection()
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
              clearNoteSelection()
              setArchived(true)
              setSelectedLabel(null)
              setNavOpen(false)
            }}
          >
            <Archive aria-hidden="true" /> {t('shell.nav.archive')}
          </button>
        </nav>
        <div className="mobile-account">
          <div className="mobile-account-bar">
            <span className="avatar" aria-hidden="true">
              {user.email.slice(0, 1).toUpperCase()}
            </span>
            <span className="user-login">{user.email}</span>
            <button type="button" className="icon-button" onClick={() => void onLogout()} aria-label={t('common.actions.signOut')}>
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
            <Settings aria-hidden="true" /> {t('shell.account.userSettings')}
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
              <Users aria-hidden="true" /> {t('shell.account.manageUsers')}
            </button>
          )}
          <button
            type="button"
            className="mobile-import"
            disabled={!online}
            onClick={() => {
              if (!online) return
              setNavOpen(false)
              setImportOpen(true)
            }}
          >
            <FileUp aria-hidden="true" /> {t('shell.account.importFromKeep')}
          </button>
        </div>
        <p className="sidebar-status" title={syncStatus.lastError ?? undefined}>
          <span
            className={
              syncStatus.kind === 'offline' || syncStatus.kind === 'error'
                ? 'offline-dot'
                : 'online-dot'
            }
          />
          {syncStatusLabel(t, syncStatus)}
        </p>
      </aside>

      <main className="workspace">
        <div className="workspace-heading">
          <div>
            <span className="eyebrow">{query ? t('notes.heading.searchResults') : t('notes.heading.workspace')}</span>
            <h1>
              {archived
                ? t('notes.heading.archive')
                : selectedLabel
                  ? selectedLabel
                  : t('notes.heading.yourNotes')}
            </h1>
          </div>
          {!archived && !selectionMode && (
            <div className="create-actions" aria-label={t('notes.addNote')}>
              <button
                type="button"
                className="primary-button"
                onClick={() => void createNote()}
                disabled={creating || waitingForVault}
              >
                {creating ? <LoaderCircle className="spin" /> : <Plus />}
                {t('notes.addNote')}
              </button>
            </div>
          )}
        </div>

        {searchError && <div className="inline-error" role="alert">{searchError}</div>}
        {loadError && (
          <div className="state-panel error-state" role="alert">
            <h2>{t('notes.loadError.title')}</h2>
            <p>{loadError}</p>
            <button type="button" className="secondary-button" onClick={() => void hydrateFromLocal()}>
              <RefreshCw /> {t('notes.loadError.retry')}
            </button>
          </div>
        )}
        {(waitingForVault || loading) && !loadError && (
          <div className="state-panel" role="status">
            <LoaderCircle className="spin large" />
            <p>{t('notes.loading')}</p>
          </div>
        )}
        {!waitingForVault && !loading && !loadError && visibleNotes.length === 0 && (
          <div className="state-panel empty-state">
            <span className="empty-icon" aria-hidden="true">
              {archived ? <Archive /> : selectedLabel ? <Tag /> : <StickyNote />}
            </span>
            <h2>
              {query
                ? t('notes.empty.noMatchTitle')
                : archived
                  ? t('notes.empty.archiveEmptyTitle')
                  : selectedLabel
                    ? t('notes.empty.labelEmptyTitle', { label: selectedLabel })
                    : t('notes.empty.noNotesTitle')}
            </h2>
            <p>
              {query
                ? t('notes.empty.noMatchBody')
                : archived
                  ? t('notes.empty.archiveEmptyBody')
                  : selectedLabel
                    ? t('notes.empty.labelEmptyBody')
                    : t('notes.empty.noNotesBody')}
            </p>
            {!archived && !query && (
              <button type="button" className="primary-button" onClick={() => void createNote()}>
                <Plus /> {t('notes.addNote')}
              </button>
            )}
          </div>
        )}
        {!waitingForVault && !loading && visibleNotes.length > 0 && (
          <div
            className="notes-board"
            aria-label={
              archived
                ? t('notes.heading.archive')
                : selectedLabel
                  ? selectedLabel
                  : t('shell.nav.notes')
            }
          >
            {pinnedNotes.length > 0 && (
              <section className="notes-section" aria-labelledby="pinned-notes-heading">
                <h2 id="pinned-notes-heading" className="notes-section-title">
                  {t('notes.sections.pinned')}
                </h2>
                <NotesMasonry notes={pinnedNotes} renderNote={renderNoteCard} />
              </section>
            )}
            {otherNotes.length > 0 && (
              <section
                className="notes-section"
                aria-labelledby={pinnedNotes.length > 0 ? 'other-notes-heading' : undefined}
                aria-label={pinnedNotes.length > 0 ? undefined : archived ? t('notes.heading.archive') : t('shell.nav.notes')}
              >
                {pinnedNotes.length > 0 && (
                  <h2 id="other-notes-heading" className="notes-section-title">
                    {t('notes.sections.others')}
                  </h2>
                )}
                <NotesMasonry notes={otherNotes} renderNote={renderNoteCard} />
              </section>
            )}
          </div>
        )}
      </main>

      {selectedNote && (
        <Suspense fallback={null}>
          <NoteEditor
            note={selectedNote}
            knownLabels={knownLabels}
            cancelIfEmpty={pendingNewNoteId === selectedNote.id}
            startInEditMode={pendingNewNoteId === selectedNote.id}
            online={online}
            persistLocal={persistLocalWrite}
            ensureLabelIds={async (names) => {
              if (!vaultKey) throw new Error(t('errors.vaultLocked'))
              if (!online) throw new Error(t('notes.offline.requiresConnection'))
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
        </Suspense>
      )}
      {importOpen && online && (
        <KeepImportDialog
          onClose={() => setImportOpen(false)}
          onCompleted={async () => {
            engineRef.current?.kick()
            await hydrateFromLocal()
            setToast(t('import.toastCompleted'))
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
          <button type="button" className="icon-button small" onClick={() => setToast('')} aria-label={t('shell.toasts.dismiss')}>
            <X />
          </button>
        </div>
      )}
    </div>
  )
}
