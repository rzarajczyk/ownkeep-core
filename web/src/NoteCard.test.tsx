import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOTE_LONG_PRESS_MS, NoteCard } from './NoteCard'
import type { Note } from './types'

const note: Note = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'TEXT',
  title: 'Trip ideas',
  contentRaw: 'Visit the coast',
  contentRendered: '',
  backgroundColor: '#ffffff',
  archived: false,
  pinned: false,
  labels: [],
  labelIds: [],
  items: [],
  attachments: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
}

function renderCard(
  options: {
    selectionMode?: boolean
    selected?: boolean
    onOpen?: (selectedNote: Note) => void
    onSelectionChange?: (selectedNote: Note, selected: boolean) => void
  } = {},
) {
  const onOpen = options.onOpen ?? vi.fn<(selectedNote: Note) => void>()
  const onSelectionChange =
    options.onSelectionChange ??
    vi.fn<(selectedNote: Note, selected: boolean) => void>()
  render(
    <NoteCard
      note={note}
      onOpen={onOpen}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
      selectionMode={options.selectionMode}
      selected={options.selected}
      onSelectionChange={onSelectionChange}
    />,
  )
  return { onOpen, onSelectionChange }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('NoteCard selection', () => {
  it('opens from the card but selects from the corner checkbox', () => {
    const { onOpen, onSelectionChange } = renderCard()

    fireEvent.click(screen.getByRole('article', { name: 'Trip ideas' }))
    expect(onOpen).toHaveBeenCalledWith(note)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Trip ideas' }))
    expect(onSelectionChange).toHaveBeenCalledWith(note, true)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('toggles selection instead of opening while selection mode is active', () => {
    const { onOpen, onSelectionChange } = renderCard({
      selectionMode: true,
      selected: true,
    })
    const card = screen.getByRole('article', { name: 'Trip ideas' })

    fireEvent.click(card)
    fireEvent.keyDown(card, { key: ' ' })

    expect(onSelectionChange).toHaveBeenCalledTimes(2)
    expect(onSelectionChange).toHaveBeenNthCalledWith(1, note, false)
    expect(onSelectionChange).toHaveBeenNthCalledWith(2, note, false)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('enters selection mode after a touch long press and suppresses the release click', () => {
    vi.useFakeTimers()
    const { onOpen, onSelectionChange } = renderCard()
    const card = screen.getByRole('article', { name: 'Trip ideas' })

    fireEvent.pointerDown(card, { pointerType: 'touch', clientX: 20, clientY: 20 })
    act(() => vi.advanceTimersByTime(NOTE_LONG_PRESS_MS))
    fireEvent.pointerUp(card, { pointerType: 'touch', clientX: 20, clientY: 20 })
    fireEvent.click(card)

    expect(onSelectionChange).toHaveBeenCalledWith(note, true)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('cancels a pending long press when the pointer moves to scroll', () => {
    vi.useFakeTimers()
    const { onOpen, onSelectionChange } = renderCard()
    const card = screen.getByRole('article', { name: 'Trip ideas' })

    fireEvent.pointerDown(card, { pointerType: 'touch', clientX: 20, clientY: 20 })
    fireEvent.pointerMove(card, { pointerType: 'touch', clientX: 20, clientY: 40 })
    act(() => vi.advanceTimersByTime(NOTE_LONG_PRESS_MS))

    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('does not swallow the next tap when a completed long press is cancelled', () => {
    vi.useFakeTimers()
    const { onOpen, onSelectionChange } = renderCard()
    const card = screen.getByRole('article', { name: 'Trip ideas' })

    fireEvent.pointerDown(card, { pointerType: 'touch', clientX: 20, clientY: 20 })
    act(() => vi.advanceTimersByTime(NOTE_LONG_PRESS_MS))
    fireEvent.pointerCancel(card, { pointerType: 'touch' })
    fireEvent.click(card)

    expect(onSelectionChange).toHaveBeenCalledWith(note, true)
    expect(onOpen).toHaveBeenCalledWith(note)
  })
})
