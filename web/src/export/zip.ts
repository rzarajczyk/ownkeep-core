import { zipSync } from 'fflate'
import { noteToMarkdown } from './markdown'
import { uniquifyFilenames } from './filename'
import type { ExportBinary } from './types'
import type { Note } from '../types'

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

export function noteToMarkdownZip(
  note: Note,
  basename: string,
  images: ExportBinary[],
  files: ExportBinary[],
): Uint8Array {
  const names = uniquifyFilenames([
    `${basename}.md`,
    ...images.map((image) => image.filename),
    ...files.map((file) => file.filename),
  ])
  const mdName = names[0]!
  const imageNames = names.slice(1, 1 + images.length)
  const fileNames = names.slice(1 + images.length)
  const markdown = noteToMarkdown(note, {
    images: imageNames,
    files: fileNames,
  })
  const entries: Record<string, Uint8Array> = {
    [mdName]: new TextEncoder().encode(markdown),
  }
  images.forEach((image, index) => {
    if (image.bytes) entries[imageNames[index]!] = copyBytes(image.bytes)
  })
  files.forEach((file, index) => {
    if (file.bytes) entries[fileNames[index]!] = copyBytes(file.bytes)
  })
  return zipSync(entries)
}
