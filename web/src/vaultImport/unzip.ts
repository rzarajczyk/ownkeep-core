import { unzipSync } from 'fflate'

export function unzipArchive(
  zipBytes: Uint8Array,
  maxUncompressedBytes: number,
  tooLargeMessage: string,
): Record<string, Uint8Array> {
  let uncompressed = 0
  return unzipSync(zipBytes, {
    filter(entry) {
      uncompressed += entry.originalSize
      if (uncompressed > maxUncompressedBytes) {
        throw new Error(tooLargeMessage)
      }
      return !entry.name.includes('__MACOSX')
    },
  })
}
