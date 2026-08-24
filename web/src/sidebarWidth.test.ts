import { afterEach, describe, expect, it } from 'vitest'
import {
  clampSidebarWidth,
  readSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STORAGE_KEY,
  writeSidebarWidth,
} from './sidebarWidth'

afterEach(() => {
  localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY)
})

describe('clampSidebarWidth', () => {
  it('keeps values inside the allowed range', () => {
    expect(clampSidebarWidth(230)).toBe(230)
    expect(clampSidebarWidth(SIDEBAR_WIDTH_MIN - 40)).toBe(SIDEBAR_WIDTH_MIN)
    expect(clampSidebarWidth(SIDEBAR_WIDTH_MAX + 80)).toBe(SIDEBAR_WIDTH_MAX)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT)
  })
})

describe('sidebar width storage', () => {
  it('returns the default when nothing is stored', () => {
    expect(readSidebarWidth()).toBe(SIDEBAR_WIDTH_DEFAULT)
  })

  it('round-trips a clamped width', () => {
    writeSidebarWidth(310)
    expect(readSidebarWidth()).toBe(310)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('310')
  })

  it('clamps values written to storage', () => {
    writeSidebarWidth(12)
    expect(readSidebarWidth()).toBe(SIDEBAR_WIDTH_MIN)
  })
})
