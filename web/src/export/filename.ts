function stripUnsafeFilenameChars(value: string): string {
  return [...value]
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code >= 32 && !'<>:"/\\|?*'.includes(char)
    })
    .join('')
}

export function noteExportBasename(title: string): string {
  const trimmed = title.trim().slice(0, 80)
  const safe = stripUnsafeFilenameChars(trimmed).replace(/\s+/g, ' ').trim()
  return safe || 'note'
}

export function sanitizeEntryName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop()?.trim() || 'file'
  const cleaned =
    [...base]
      .map((char) => {
        const code = char.charCodeAt(0)
        if (code < 32 || '<>:"/\\|?*'.includes(char)) return '_'
        return char
      })
      .join('')
      .replace(/^\.+/, '') || 'file'
  return cleaned
}

export function uniquifyFilenames(names: string[]): string[] {
  const used = new Map<string, number>()
  return names.map((name) => {
    const safe = sanitizeEntryName(name)
    const key = safe.toLowerCase()
    const count = used.get(key) ?? 0
    used.set(key, count + 1)
    if (count === 0) return safe
    const dot = safe.lastIndexOf('.')
    const stem = dot > 0 ? safe.slice(0, dot) : safe
    const ext = dot > 0 ? safe.slice(dot) : ''
    return `${stem}-${count + 1}${ext}`
  })
}
