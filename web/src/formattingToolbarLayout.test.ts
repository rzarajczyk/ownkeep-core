import { describe, expect, it, vi } from 'vitest'
import {
  firstVisibleRect,
  placeFormattingToolbar,
} from './formattingToolbarLayout'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height)
}

describe('placeFormattingToolbar', () => {
  function fakeDialog(bounds: DOMRect): HTMLDialogElement {
    return {
      getBoundingClientRect: () => bounds,
    } as HTMLDialogElement
  }

  function fakeToolbar(width: number, height: number): HTMLElement {
    return {
      offsetWidth: width,
      offsetHeight: height,
    } as HTMLElement
  }

  it('places the toolbar above the selection when there is room', () => {
    const dialog = fakeDialog(rect(0, 0, 400, 800))
    const toolbar = fakeToolbar(280, 42)
    const position = placeFormattingToolbar(dialog, toolbar, {
      top: 200,
      bottom: 220,
      centerX: 200,
    })
    expect(position.top).toBe(138)
    expect(position.left).toBe(200)
  })

  it('flips below the selection when there is no room above', () => {
    const dialog = fakeDialog(rect(0, 0, 400, 800))
    const toolbar = fakeToolbar(280, 42)
    const position = placeFormattingToolbar(dialog, toolbar, {
      top: 30,
      bottom: 50,
      centerX: 200,
    })
    expect(position.top).toBe(70)
  })

  it('clamps horizontally inside the dialog', () => {
    const dialog = fakeDialog(rect(0, 0, 400, 800))
    const toolbar = fakeToolbar(280, 42)
    const position = placeFormattingToolbar(dialog, toolbar, {
      top: 200,
      bottom: 220,
      centerX: 10,
    })
    expect(position.left).toBe(148)
  })
})

describe('firstVisibleRect', () => {
  it('returns the first rect that intersects the bounds', () => {
    const bounds = rect(0, 100, 200, 100)
    const visible = firstVisibleRect([rect(10, 10, 20, 20), rect(20, 120, 30, 20)], bounds)
    expect(visible).toEqual(rect(20, 120, 30, 20))
  })

  it('returns null when nothing intersects', () => {
    expect(firstVisibleRect([rect(0, 0, 10, 10)], rect(50, 50, 10, 10))).toBeNull()
  })
})

describe('domSelectionRect empty clientRects fallback', () => {
  it('uses getBoundingClientRect when getClientRects is empty', async () => {
    const { domSelectionRect } = await import('./formattingToolbarLayout')

    const host = document.createElement('div')
    host.className = 'rich-block-editor'
    const text = document.createTextNode('hello world')
    host.append(text)
    document.body.append(host)

    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 5)

    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => [] as unknown as DOMRectList,
    })
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(12, 40, 80, 18),
    })
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 300, 200))

    expect(domSelectionRect('.rich-block-editor')).toEqual(rect(12, 40, 80, 18))

    selection?.removeAllRanges()
    host.remove()
  })
})
