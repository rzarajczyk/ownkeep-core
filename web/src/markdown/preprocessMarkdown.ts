/**
 * Normalize markdown before parsing so Preview / Visual edit follow OwnKeep rules:
 * - no GFM task lists (app uses LIST notes for checkboxes)
 * - no reference-link / footnote definitions
 * - ~sub~ and ^sup^ expanded to HTML (strike stays ~~text~~)
 */

/** Escape list-item `[ ]` / `[x]` markers so marked does not emit task checkboxes. */
export function neutralizeTaskListMarkers(markdown: string): string {
  return markdown.replace(
    /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\](?=\s)/gm,
    '$1\\[$2\\]',
  )
}

/** Escape `[label]:` reference definitions (footnotes, link refs, def lists). */
export function neutralizeReferenceDefinitions(markdown: string): string {
  return markdown.replace(/^(\s*)\[((?:[^\]\n]|\\\])+)\]:\s+/gm, '$1\\[$2\\]: ')
}

/** Convert ~sub~ and ^sup^ to HTML; leave ~~strike~~ untouched. */
export function expandSubSuperscript(markdown: string): string {
  return markdown
    .replace(/(?<!~)~([^~\n]+)~(?!~)/g, '<sub>$1</sub>')
    .replace(/(?<!\[)\^(?!\^)([^^\n]+)\^(?!\^)/g, '<sup>$1</sup>')
}

export function preprocessMarkdown(markdown: string): string {
  return expandSubSuperscript(
    neutralizeReferenceDefinitions(neutralizeTaskListMarkers(markdown)),
  )
}
