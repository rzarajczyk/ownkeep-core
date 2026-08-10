import type { Note } from './types'
import { noteIsNewer } from './offline/lww'

export interface NotesState {
  byId: Record<string, Note>
  order: string[]
}

export type NotesAction =
  | { type: 'replace'; notes: Note[] }
  | { type: 'reconcile'; notes: Note[]; deletedIds: string[] }
  | { type: 'upsert'; note: Note }
  | { type: 'remove'; id: string }

export const initialNotesState: NotesState = { byId: {}, order: [] }

function newestFirst(a: Note, b: Note) {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    new Date(b.clientUpdatedAt ?? b.updatedAt).getTime() -
      new Date(a.clientUpdatedAt ?? a.updatedAt).getTime() ||
    b.id.localeCompare(a.id)
  )
}

function normalize(notes: Note[]): NotesState {
  const byId = Object.fromEntries(notes.map((note) => [note.id, note]))
  return {
    byId,
    order: Object.values(byId).sort(newestFirst).map((note) => note.id),
  }
}

export function notesReducer(state: NotesState, action: NotesAction): NotesState {
  switch (action.type) {
    case 'replace':
      return normalize(action.notes)
    case 'reconcile': {
      const byId = { ...state.byId }
      action.deletedIds.forEach((id) => delete byId[id])
      action.notes.forEach((note) => {
        const current = byId[note.id]
        if (!current || noteIsNewer(note, current)) byId[note.id] = note
      })
      return normalize(Object.values(byId))
    }
    case 'upsert':
      return normalize([...Object.values(state.byId), action.note])
    case 'remove':
      return normalize(Object.values(state.byId).filter((note) => note.id !== action.id))
  }
}

export function selectNotes(state: NotesState, archived: boolean) {
  return state.order
    .map((id) => state.byId[id])
    .filter((note) => note.archived === archived)
}
