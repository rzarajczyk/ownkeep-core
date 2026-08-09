export type FormattingSelectionAnchor = {
  top: number
  bottom: number
  centerX: number
}

export type FormattingToolbarPosition = {
  top: number
  left: number
}

export function intersectRects(rect: DOMRect, bounds: DOMRect): DOMRect | null {
  const top = Math.max(rect.top, bounds.top)
  const right = Math.min(rect.right, bounds.right)
  const bottom = Math.min(rect.bottom, bounds.bottom)
  const left = Math.max(rect.left, bounds.left)
  if (right <= left || bottom <= top) return null
  return new DOMRect(left, top, right - left, bottom - top)
}

export function firstVisibleRect(rects: DOMRectList | DOMRect[], bounds: DOMRect): DOMRect | null {
  return [...rects]
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .map((rect) => intersectRects(rect, bounds))
    .find((rect): rect is DOMRect => rect !== null) ?? null
}

export function textControlSelectionRect(
  control: HTMLInputElement | HTMLTextAreaElement,
): DOMRect | null {
  const start = control.selectionStart
  const end = control.selectionEnd
  if (start === null || end === null || start === end) return null

  const controlRect = control.getBoundingClientRect()
  const styles = window.getComputedStyle(control)
  const mirror = document.createElement('div')
  const marker = document.createElement('span')
  Object.assign(mirror.style, {
    position: 'fixed',
    top: `${controlRect.top - control.scrollTop}px`,
    left: `${controlRect.left - control.scrollLeft}px`,
    width: `${control.clientWidth}px`,
    boxSizing: 'border-box',
    padding: styles.padding,
    border: styles.border,
    font: styles.font,
    letterSpacing: styles.letterSpacing,
    lineHeight: styles.lineHeight,
    textAlign: styles.textAlign,
    textIndent: styles.textIndent,
    textTransform: styles.textTransform,
    whiteSpace: control instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre',
    overflowWrap: 'break-word',
    visibility: 'hidden',
    pointerEvents: 'none',
  })
  mirror.textContent = control.value.slice(0, start)
  marker.textContent = control.value.slice(start, end) || ' '
  mirror.append(marker)
  document.body.append(mirror)
  const rect = firstVisibleRect(marker.getClientRects(), controlRect)
  mirror.remove()
  return rect
}

export function domSelectionRect(rootSelector: string): DOMRect | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const selectedNode =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement
  if (!selectedNode?.closest(rootSelector)) return null

  const viewport =
    selectedNode.closest<HTMLElement>('.rich-block-editor-host, .checklist-editor')
      ?.getBoundingClientRect() ?? selectedNode.getBoundingClientRect()
  const fromClientRects = firstVisibleRect(range.getClientRects(), viewport)
  if (fromClientRects) return fromClientRects

  // Mobile browsers (notably iOS) sometimes report empty client rects for a live selection.
  const bounding = range.getBoundingClientRect()
  if (bounding.width === 0 && bounding.height === 0) return null
  return intersectRects(bounding, viewport)
}

export function placeFormattingToolbar(
  dialog: HTMLDialogElement,
  toolbar: HTMLElement,
  anchor: FormattingSelectionAnchor,
): FormattingToolbarPosition {
  const pad = 8
  const gap = 20
  const toolbarHeight = Math.max(toolbar.offsetHeight, 42)
  const toolbarWidth = Math.max(toolbar.offsetWidth, 280)
  const dialogRect = dialog.getBoundingClientRect()
  const halfWidth = toolbarWidth / 2
  const left = Math.min(
    dialogRect.right - halfWidth - pad,
    Math.max(dialogRect.left + halfWidth + pad, anchor.centerX),
  )
  const minTop = dialogRect.top + pad
  const maxTop = Math.max(minTop, dialogRect.bottom - toolbarHeight - pad)
  const above = anchor.top - toolbarHeight - gap
  const below = anchor.bottom + gap
  const top = above >= minTop ? Math.min(above, maxTop) : Math.min(Math.max(below, minTop), maxTop)
  return { top, left }
}
