export const SIDEBAR_WIDTH_STORAGE_KEY = 'ownkeep.sidebarWidth'
export const SIDEBAR_WIDTH_DEFAULT = 230
export const SIDEBAR_WIDTH_MIN = 176
export const SIDEBAR_WIDTH_MAX = 420
export const SIDEBAR_WIDTH_STEP = 16

export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)))
}

export function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (raw == null || raw === '') return SIDEBAR_WIDTH_DEFAULT
    return clampSidebarWidth(Number(raw))
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
}

export function writeSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)))
  } catch {
    // ignore quota / private-mode failures
  }
}
