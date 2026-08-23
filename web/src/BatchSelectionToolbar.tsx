import {
  Archive,
  ArchiveRestore,
  Check,
  CheckCheck,
  LoaderCircle,
  Palette,
  Tag,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Note } from './types'
import { NOTE_COLORS } from './utils'

interface BatchSelectionToolbarProps {
  selectedNotes: Note[]
  visibleCount: number
  allVisibleSelected: boolean
  archived: boolean
  busy: boolean
  knownLabels: string[]
  onClear: () => void
  onToggleAll: () => void
  onApplyColor: (color: string) => Promise<void>
  onAddLabel: (label: string) => Promise<void>
  onRemoveLabel: (label: string) => Promise<void>
  onArchive: () => Promise<void>
}

type OpenMenu = 'color' | 'labels' | null
type LabelMode = 'add' | 'remove'

function normalizedColor(color: string) {
  return color && color !== 'default' ? color : '#ffffff'
}

export function BatchSelectionToolbar({
  selectedNotes,
  visibleCount,
  allVisibleSelected,
  archived,
  busy,
  knownLabels,
  onClear,
  onToggleAll,
  onApplyColor,
  onAddLabel,
  onRemoveLabel,
  onArchive,
}: BatchSelectionToolbarProps) {
  const { t } = useTranslation()
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [labelMode, setLabelMode] = useState<LabelMode>('add')
  const toolbarRef = useRef<HTMLDivElement>(null)

  const selectedColor = useMemo(() => {
    const colors = new Set(selectedNotes.map((note) => normalizedColor(note.backgroundColor)))
    return colors.size === 1 ? [...colors][0] : null
  }, [selectedNotes])

  const labelCounts = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const note of selectedNotes) {
      const seen = new Set<string>()
      for (const label of note.labels) {
        const key = label.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const current = counts.get(key)
        counts.set(key, {
          label: current?.label ?? label,
          count: (current?.count ?? 0) + 1,
        })
      }
    }
    return counts
  }, [selectedNotes])

  const addLabels = useMemo(() => {
    const names = new Map<string, string>()
    for (const label of [...knownLabels, ...selectedNotes.flatMap((note) => note.labels)]) {
      const key = label.toLowerCase()
      if (!names.has(key)) names.set(key, label)
    }
    return [...names.values()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    )
  }, [knownLabels, selectedNotes])

  const removeLabels = useMemo(
    () =>
      [...labelCounts.values()].sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
      ),
    [labelCounts],
  )

  useEffect(() => {
    if (!openMenu) return
    const closeOutside = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) setOpenMenu(null)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [openMenu])

  return (
    <div
      className="batch-toolbar"
      role="toolbar"
      aria-label={t('notes.batch.toolbar')}
      aria-busy={busy}
      ref={toolbarRef}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !openMenu) return
        event.preventDefault()
        event.stopPropagation()
        setOpenMenu(null)
      }}
      onBlur={(event) => {
        if (!toolbarRef.current?.contains(event.relatedTarget)) setOpenMenu(null)
      }}
    >
      <button
        type="button"
        className="icon-button batch-close"
        onClick={onClear}
        disabled={busy}
        aria-label={t('notes.batch.selectNone')}
      >
        <X />
      </button>

      <span className="batch-count" aria-live="polite" aria-atomic="true">
        {busy
          ? t('notes.batch.applying')
          : t('notes.batch.selectedCount', { count: selectedNotes.length })}
      </span>

      <div className="batch-actions">
        <button
          type="button"
          className="icon-button"
          onClick={onToggleAll}
          disabled={busy || visibleCount === 0}
          aria-label={
            allVisibleSelected ? t('notes.batch.selectNone') : t('notes.batch.selectAll')
          }
          aria-pressed={allVisibleSelected}
        >
          <CheckCheck />
        </button>

        <div className="batch-menu-wrap">
          <button
            type="button"
            className="icon-button"
            onClick={() => setOpenMenu((current) => (current === 'color' ? null : 'color'))}
            disabled={busy}
            aria-label={t('notes.batch.color')}
            aria-expanded={openMenu === 'color'}
          >
            <Palette />
          </button>
          {openMenu === 'color' && (
            <div
              className="batch-popover batch-color-menu"
              aria-label={t('notes.batch.color')}
            >
              <p>{t('notes.batch.chooseColor')}</p>
              <div
                className="batch-color-grid"
                role="group"
                aria-label={t('notes.batch.chooseColor')}
              >
                {NOTE_COLORS.map((color) => {
                  const active = selectedColor === color.value
                  return (
                    <button
                      type="button"
                      aria-pressed={active}
                      aria-label={t(`notes.colors.${color.labelKey}`)}
                      className={active ? 'active' : ''}
                      disabled={active}
                      style={{ backgroundColor: color.value }}
                      onClick={() => {
                        setOpenMenu(null)
                        void onApplyColor(color.value)
                      }}
                      key={color.value}
                    >
                      {active && <Check aria-hidden="true" />}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div className="batch-menu-wrap">
          <button
            type="button"
            className="icon-button"
            onClick={() => setOpenMenu((current) => (current === 'labels' ? null : 'labels'))}
            disabled={busy}
            aria-label={t('notes.batch.labels')}
            aria-expanded={openMenu === 'labels'}
          >
            <Tag />
          </button>
          {openMenu === 'labels' && (
            <div
              className="batch-popover batch-label-menu"
              aria-label={t('notes.batch.labels')}
            >
              <div
                className="batch-label-tabs"
                role="group"
                aria-label={t('notes.batch.labelAction')}
              >
                <button
                  type="button"
                  aria-pressed={labelMode === 'add'}
                  onClick={() => setLabelMode('add')}
                >
                  {t('notes.batch.addLabel')}
                </button>
                <button
                  type="button"
                  aria-pressed={labelMode === 'remove'}
                  onClick={() => setLabelMode('remove')}
                >
                  {t('notes.batch.removeLabel')}
                </button>
              </div>
              <div
                className="batch-label-list"
                aria-label={
                  labelMode === 'add'
                    ? t('notes.batch.addLabel')
                    : t('notes.batch.removeLabel')
                }
              >
                {labelMode === 'add' &&
                  (addLabels.length > 0 ? (
                    addLabels.map((label) => {
                      const count = labelCounts.get(label.toLowerCase())?.count ?? 0
                      const assignedToAll = count === selectedNotes.length
                      return (
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={assignedToAll ? true : count > 0 ? 'mixed' : false}
                          aria-label={t('notes.batch.addLabelAction', {
                            label,
                            count,
                            selected: selectedNotes.length,
                          })}
                          disabled={assignedToAll}
                          onClick={() => {
                            setOpenMenu(null)
                            void onAddLabel(label)
                          }}
                          key={label}
                        >
                          <span className="batch-label-check" aria-hidden="true">
                            {assignedToAll ? '✓' : count > 0 ? '−' : ''}
                          </span>
                          <span>{label}</span>
                          {count > 0 && (
                            <small>
                              {t('notes.batch.labelCount', {
                                count,
                                selected: selectedNotes.length,
                              })}
                            </small>
                          )}
                        </button>
                      )
                    })
                  ) : (
                    <p className="batch-menu-empty">{t('notes.batch.noLabels')}</p>
                  ))}
                {labelMode === 'remove' &&
                  (removeLabels.length > 0 ? (
                    removeLabels.map(({ label, count }) => (
                      <button
                        type="button"
                        aria-label={t('notes.batch.removeLabelAction', {
                          label,
                          count,
                          selected: selectedNotes.length,
                        })}
                        onClick={() => {
                          setOpenMenu(null)
                          void onRemoveLabel(label)
                        }}
                        key={label}
                      >
                        <span className="batch-label-check remove" aria-hidden="true">−</span>
                        <span>{label}</span>
                        <small>
                          {t('notes.batch.labelCount', {
                            count,
                            selected: selectedNotes.length,
                          })}
                        </small>
                      </button>
                    ))
                  ) : (
                    <p className="batch-menu-empty">{t('notes.batch.noAssignedLabels')}</p>
                  ))}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          className="icon-button"
          onClick={() => void onArchive()}
          disabled={busy}
          aria-label={archived ? t('notes.batch.restore') : t('notes.batch.archive')}
        >
          {busy ? (
            <LoaderCircle className="spin" />
          ) : archived ? (
            <ArchiveRestore />
          ) : (
            <Archive />
          )}
        </button>
      </div>
    </div>
  )
}
