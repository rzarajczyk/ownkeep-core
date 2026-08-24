import type { BlockNode, ExportBinary, ExportDocument, InlineNode, ListItemNode } from './types'
import { flattenRuns, hasMark, type TextRun } from './runs'
import { ensurePngOrJpeg, imageDisplaySize } from './images'
import { uniquifyFilenames } from './filename'

function rtfEscape(text: string): string {
  let out = ''
  for (const char of text) {
    if (char === '\\' || char === '{' || char === '}') {
      out += `\\${char}`
      continue
    }
    if (char === '\n') {
      out += '\\par\n'
      continue
    }
    const code = char.codePointAt(0) ?? 0
    if (code < 128) {
      out += char
      continue
    }
    const signed = code > 32767 ? code - 65536 : code
    out += `\\u${signed}?`
  }
  return out
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0')
    if ((i + 1) % 64 === 0) hex += '\n'
  }
  return hex
}

function runRtf(run: TextRun): string {
  let inner = rtfEscape(run.text)
  if (hasMark(run, 'bold')) inner = `{\\b ${inner}}`
  if (hasMark(run, 'italic')) inner = `{\\i ${inner}}`
  if (hasMark(run, 'underline')) inner = `{\\ul ${inner}}`
  if (hasMark(run, 'strike')) inner = `{\\strike ${inner}}`
  if (hasMark(run, 'code')) inner = `{\\f1 ${inner}}`
  if (hasMark(run, 'sub')) inner = `{\\sub ${inner}}`
  if (hasMark(run, 'sup')) inner = `{\\super ${inner}}`
  if (run.href && run.href !== run.text) {
    inner = `{\\field{\\*\\fldinst HYPERLINK "${rtfEscape(run.href)}"}{\\fldrslt ${inner}}}`
  }
  return inner
}

function inlinesRtf(inlines: InlineNode[]): string {
  return flattenRuns(inlines).map(runRtf).join('')
}

function listItems(items: ListItemNode[], ordered: boolean): string {
  return items
    .map((item, index) => {
      const bullet = ordered ? `${index + 1}. ` : '\\bullet '
      const nested = item.nested?.length ? renderBlocks(item.nested) : ''
      return `{\\pard\\li360 ${bullet}${inlinesRtf(item.inlines)}\\par}${nested}`
    })
    .join('')
}

function renderBlocks(blocks: BlockNode[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'heading':
          return `{\\pard\\sa120\\b\\fs${32 - block.level * 2} ${inlinesRtf(block.inlines)}\\par}\n`
        case 'paragraph':
          return `{\\pard\\sa80 ${inlinesRtf(block.inlines)}\\par}\n`
        case 'code':
          return `{\\pard\\sa80\\f1 ${rtfEscape(block.text)}\\par}\n`
        case 'hr':
          return '{\\pard\\brdrb\\brdrs\\brdrw10\\brsp20 \\par}\n'
        case 'blockquote':
          return `{\\pard\\li400 ${renderBlocks(block.blocks)}}`
        case 'list':
          return listItems(block.items, block.ordered)
        case 'checklist':
          return block.items
            .map((item) => {
              const mark = item.checked ? '\\u9745?' : '\\u9744?'
              const li = 360 * ((item.indent ?? 0) + 1)
              return `{\\pard\\li${li} ${mark} ${inlinesRtf(item.inlines)}\\par}\n`
            })
            .join('')
        case 'table': {
          const cells = [block.header, ...block.rows]
          const colCount = Math.max(1, ...cells.map((row) => row.length))
          const cellWidth = Math.floor(9000 / colCount)
          return cells
            .map((row) => {
              const cellx = Array.from({ length: colCount }, (_, i) => `\\cellx${(i + 1) * cellWidth}`).join('')
              const content = Array.from({ length: colCount }, (_, i) => `${inlinesRtf(row[i] ?? [])}\\cell`).join(' ')
              return `\\trowd\\trgaph70${cellx}\\pard\\intbl ${content}\\row\n`
            })
            .join('')
        }
      }
    })
    .join('')
}

async function pictRtf(image: ExportBinary, filename: string): Promise<string> {
  const caption = `{\\pard\\sa80\\i ${rtfEscape(filename)}\\par}\n`
  if (!image.bytes) return caption
  const converted = await ensurePngOrJpeg(image.mimeType, image.bytes)
  if (!converted) return caption
  const size = imageDisplaySize(converted.mimeType, converted.bytes)
  const blip = converted.mimeType === 'image/png' ? 'pngblip' : 'jpegblip'
  const picw = Math.round(size.widthIn * 1440)
  const pich = Math.round(size.heightIn * 1440)
  return `{\\pict\\${blip}\\picwgoal${picw}\\pichgoal${pich}\n${toHex(converted.bytes)}\n}\\par\n${caption}`
}

export async function noteToRtf(doc: ExportDocument, images: ExportBinary[]): Promise<string> {
  const names = uniquifyFilenames(images.map((image) => image.filename))
  let appendix = ''
  for (const [index, image] of images.entries()) {
    appendix += await pictRtf(image, names[index]!)
  }
  return `{\\rtf1\\ansi\\deff0\\uc1
{\\fonttbl{\\f0 Times New Roman;}{\\f1 Courier New;}}
\\f0\\fs24
${renderBlocks(doc.blocks)}${appendix}}
`
}
