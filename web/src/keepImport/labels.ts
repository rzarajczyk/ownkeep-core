export function localDateStamp(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Label stored on notes in add mode — English on purpose, even in Polish UI. */
export function uniqueImportLabelName(existingNames: Iterable<string>, now = new Date()): string {
  const taken = new Set([...existingNames].map((name) => name.toLowerCase()))
  const base = `Google Keep import ${localDateStamp(now)}`
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base} (${n})`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  throw new Error('Could not allocate a unique import label')
}
