import { zipSync, strToU8, type Zippable } from 'fflate'
import type { BlockNode, ExportBinary, ExportDocument, InlineNode, ListItemNode } from './types'
import { flattenRuns, hasMark, type TextRun } from './runs'
import { imageDisplaySize } from './images'
import { escapeXml } from './xml'
import { uniquifyFilenames } from './filename'

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function wt(text: string): string {
  const escaped = escapeXml(text)
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''
  return `<w:t${space}>${escaped}</w:t>`
}

function runXml(run: TextRun): string {
  const rPr: string[] = []
  if (hasMark(run, 'bold')) rPr.push('<w:b/>')
  if (hasMark(run, 'italic')) rPr.push('<w:i/>')
  if (hasMark(run, 'underline')) rPr.push('<w:u w:val="single"/>')
  if (hasMark(run, 'strike')) rPr.push('<w:strike/>')
  if (hasMark(run, 'code')) rPr.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>')
  if (hasMark(run, 'sub')) rPr.push('<w:vertAlign w:val="subscript"/>')
  if (hasMark(run, 'sup')) rPr.push('<w:vertAlign w:val="superscript"/>')
  if (run.href && run.href !== run.text) rPr.push('<w:u w:val="single"/>')
  const inner = `<w:r>${rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : ''}${wt(run.text)}</w:r>`
  if (!run.href || run.href === run.text) return inner
  return `${inner}<w:r>${wt(` (${run.href})`)}</w:r>`
}

function inlinesXml(inlines: InlineNode[]): string {
  return flattenRuns(inlines)
    .flatMap((run) => {
      if (!run.text.includes('\n')) return [runXml(run)]
      return run.text.split('\n').flatMap((part, index, parts) => {
        const piece = runXml({ ...run, text: part })
        return index < parts.length - 1 ? [piece, '<w:r><w:br/></w:r>'] : [piece]
      })
    })
    .join('')
}

function p(style: string | undefined, inlines: InlineNode[], extraPr = ''): string {
  const pPr = style || extraPr ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extraPr}</w:pPr>` : ''
  return `<w:p>${pPr}${inlinesXml(inlines)}</w:p>`
}

function listItems(items: ListItemNode[], ordered: boolean): string {
  return items
    .map((item, index) => {
      const num = ordered ? `${index + 1}. ` : '• '
      const prefix: InlineNode[] = [{ type: 'text', text: num }, ...item.inlines]
      const nested = item.nested?.length ? renderBlocks(item.nested) : ''
      return `${p(undefined, prefix)}${nested}`
    })
    .join('')
}

function renderBlocks(blocks: BlockNode[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'heading':
          return p(`Heading${block.level}`, block.inlines)
        case 'paragraph':
          return p(undefined, block.inlines)
        case 'code':
          return p(undefined, [{ type: 'text', text: block.text, marks: ['code'] }])
        case 'hr':
          return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="888888"/></w:pBdr></w:pPr></w:p>'
        case 'blockquote':
          return renderBlocks(block.blocks)
        case 'list':
          return listItems(block.items, block.ordered)
        case 'checklist':
          return block.items
            .map((item) => {
              const mark = item.checked ? '☑ ' : '☐ '
              const indent = item.indent
                ? `<w:ind w:left="${item.indent * 360}"/>`
                : ''
              return p(undefined, [{ type: 'text', text: mark }, ...item.inlines], indent)
            })
            .join('')
        case 'table': {
          const rowXml = (row: InlineNode[][]) =>
            `<w:tr>${row
              .map((cell) => `<w:tc>${p(undefined, cell)}</w:tc>`)
              .join('')}</w:tr>`
          return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rowXml(block.header)}${block.rows.map(rowXml).join('')}</w:tbl>`
        }
      }
    })
    .join('')
}

function drawingXml(relId: string, name: string, cx: number, cy: number, docPrId: number): string {
  return `<w:p><w:r><w:drawing>
    <wp:inline distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="${cx}" cy="${cy}"/>
      <wp:docPr id="${docPrId}" name="${escapeXml(name)}"/>
      <wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
      <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${escapeXml(name)}"/><pic:cNvPicPr/></pic:nvPicPr>
            <pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
            <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
          </pic:pic>
        </a:graphicData>
      </a:graphic>
    </wp:inline>
  </w:drawing></w:r></w:p>`
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
</w:styles>
`

export function noteToDocx(doc: ExportDocument, images: ExportBinary[]): Uint8Array {
  const names = uniquifyFilenames(images.map((image) => image.filename))
  const media: Array<{ name: string; relId: string; bytes: Uint8Array; mime: string }> = []
  const appendix: string[] = []
  images.forEach((image, index) => {
    const filename = names[index]!
    const caption = p(undefined, [{ type: 'text', text: filename }])
    if (!image.bytes) {
      appendix.push(caption)
      return
    }
    const relId = `rIdImg${media.length + 1}`
    const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : 'bin'
    const zipName = `image${media.length + 1}.${ext}`
    media.push({ name: zipName, relId, bytes: copyBytes(image.bytes), mime: image.mimeType })
    const size = imageDisplaySize(image.mimeType, image.bytes)
    const cx = Math.round(size.widthIn * 914400)
    const cy = Math.round(size.heightIn * 914400)
    appendix.push(drawingXml(relId, filename, cx, cy, index + 1), caption)
  })

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>${renderBlocks(doc.blocks)}${appendix.join('')}<w:sectPr/></w:body>
</w:document>
`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  ${media
    .map(
      (item) =>
        `<Relationship Id="${item.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${item.name}"/>`,
    )
    .join('\n  ')}
</Relationships>
`
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>',
    '<Default Extension="jpg" ContentType="image/jpeg"/>',
    '<Default Extension="jpeg" ContentType="image/jpeg"/>',
    '<Default Extension="gif" ContentType="image/gif"/>',
    '<Default Extension="webp" ContentType="image/webp"/>',
  ]
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  ${defaults.join('\n  ')}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>
`
  const zippable: Zippable = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    'word/document.xml': strToU8(documentXml),
    'word/styles.xml': strToU8(STYLES),
    'word/_rels/document.xml.rels': strToU8(docRels),
  }
  for (const item of media) {
    zippable[`word/media/${item.name}`] = item.bytes
  }
  return zipSync(zippable)
}
