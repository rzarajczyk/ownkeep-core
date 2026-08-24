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

function spans(inlines: InlineNode[]): string {
  return flattenRuns(inlines)
    .map((run) => renderRun(run))
    .join('')
}

function renderRun(run: TextRun): string {
  let inner = escapeXml(run.text).replace(/\n/g, '<text:line-break/>')
  if (hasMark(run, 'code')) {
    inner = `<text:span text:style-name="Tcode">${inner}</text:span>`
  }
  if (hasMark(run, 'bold')) inner = `<text:span text:style-name="Tbold">${inner}</text:span>`
  if (hasMark(run, 'italic')) inner = `<text:span text:style-name="Titalic">${inner}</text:span>`
  if (hasMark(run, 'underline')) inner = `<text:span text:style-name="Tunder">${inner}</text:span>`
  if (hasMark(run, 'strike')) inner = `<text:span text:style-name="Tstrike">${inner}</text:span>`
  if (hasMark(run, 'sub')) inner = `<text:span text:style-name="Tsub">${inner}</text:span>`
  if (hasMark(run, 'sup')) inner = `<text:span text:style-name="Tsup">${inner}</text:span>`
  if (run.href) {
    inner = `<text:a xlink:href="${escapeXml(run.href)}">${inner}</text:a>`
  }
  return inner
}

function paragraph(style: string, inlines: InlineNode[]): string {
  return `<text:p text:style-name="${style}">${spans(inlines)}</text:p>`
}

function renderListItems(items: ListItemNode[], ordered: boolean): string {
  const style = ordered ? 'Lordered' : 'Lbullet'
  const body = items
    .map((item) => {
      const nested = item.nested?.length ? renderBlocks(item.nested) : ''
      return `<text:list-item>${paragraph('P1', item.inlines)}${nested}</text:list-item>`
    })
    .join('')
  return `<text:list text:style-name="${style}">${body}</text:list>`
}

function renderBlocks(blocks: BlockNode[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case 'heading':
        return `<text:h text:style-name="H${block.level}" text:outline-level="${block.level}">${spans(block.inlines)}</text:h>`
      case 'paragraph':
        return paragraph('P1', block.inlines)
      case 'code':
        return `<text:p text:style-name="Pcode">${escapeXml(block.text).replace(/\n/g, '<text:line-break/>')}</text:p>`
      case 'hr':
        return '<text:p text:style-name="Phr"/>'
      case 'blockquote':
        return renderBlocks(block.blocks)
      case 'list':
        return renderListItems(block.items, block.ordered)
      case 'checklist':
        return block.items
          .map((item) => {
            const mark = item.checked ? '☑ ' : '☐ '
            const style = item.indent ? `Pindent${Math.min(item.indent, 5)}` : 'P1'
            return `<text:p text:style-name="${style}">${escapeXml(mark)}${spans(item.inlines)}</text:p>`
          })
          .join('')
      case 'table': {
        const rowXml = (row: InlineNode[][]) =>
          `<table:table-row>${row
            .map((cell) => `<table:table-cell office:value-type="string"><text:p>${spans(cell)}</text:p></table:table-cell>`)
            .join('')}</table:table-row>`
        return `<table:table>${rowXml(block.header)}${block.rows.map(rowXml).join('')}</table:table>`
      }
    }
  }).join('')
}

function imageXml(filename: string, image: ExportBinary, index: number): string {
  const caption = `<text:p text:style-name="Pcaption">${escapeXml(filename)}</text:p>`
  if (!image.bytes) return caption
  const size = imageDisplaySize(image.mimeType, image.bytes)
  const width = `${(size.widthIn * 2.54).toFixed(2)}cm`
  const height = `${(size.heightIn * 2.54).toFixed(2)}cm`
  return `<text:p text:style-name="P1"><draw:frame draw:name="Image${index + 1}" text:anchor-type="as-char" svg:width="${width}" svg:height="${height}"><draw:image xlink:href="Pictures/${escapeXml(filename)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>${caption}`
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
  <office:styles>
    <style:style style:name="P1" style:family="paragraph" style:class="text"/>
    <style:style style:name="Phr" style:family="paragraph">
      <style:paragraph-properties fo:border-bottom="0.06pt solid #888888"/>
    </style:style>
    <style:style style:name="Pcode" style:family="paragraph">
      <style:text-properties style:font-name="Courier New" fo:font-family="Courier New"/>
    </style:style>
    <style:style style:name="Pcaption" style:family="paragraph">
      <style:text-properties fo:font-size="10pt" fo:color="#666666"/>
    </style:style>
    <style:style style:name="H1" style:family="paragraph" style:class="text">
      <style:text-properties fo:font-size="22pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="H2" style:family="paragraph" style:class="text">
      <style:text-properties fo:font-size="18pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="H3" style:family="paragraph" style:class="text">
      <style:text-properties fo:font-size="14pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="H4" style:family="paragraph" style:class="text">
      <style:text-properties fo:font-size="12pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="H5" style:family="paragraph" style:class="text">
      <style:text-properties fo:font-size="11pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="H6" style:family="paragraph" style:class="text">
      <style:text-properties fo:font-size="11pt" fo:font-weight="bold"/>
    </style:style>
    <text:list-style style:name="Lbullet">
      <text:list-level-style-bullet text:level="1" text:bullet-char="•"/>
    </text:list-style>
    <text:list-style style:name="Lordered">
      <text:list-level-style-number text:level="1" style:num-format="1"/>
    </text:list-style>
  </office:styles>
</office:document-styles>
`

function indentStyles(): string {
  return [1, 2, 3, 4, 5]
    .map(
      (level) =>
        `<style:style style:name="Pindent${level}" style:family="paragraph"><style:paragraph-properties fo:margin-left="${level * 0.75}cm"/></style:style>`,
    )
    .join('')
}

export function noteToOdt(doc: ExportDocument, images: ExportBinary[]): Uint8Array {
  const names = uniquifyFilenames(images.map((image) => image.filename))
  const body = `${renderBlocks(doc.blocks)}${images
    .map((image, index) => imageXml(names[index]!, image, index))
    .join('')}`
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  office:version="1.2">
  <office:automatic-styles>
    <style:style style:name="Tbold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
    <style:style style:name="Titalic" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
    <style:style style:name="Tunder" style:family="text"><style:text-properties style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>
    <style:style style:name="Tstrike" style:family="text"><style:text-properties style:text-line-through-style="solid"/></style:style>
    <style:style style:name="Tcode" style:family="text"><style:text-properties fo:font-family="Courier New"/></style:style>
    <style:style style:name="Tsub" style:family="text"><style:text-properties style:text-position="sub 58%"/></style:style>
    <style:style style:name="Tsup" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>
    ${indentStyles()}
  </office:automatic-styles>
  <office:body><office:text>${body}</office:text></office:body>
</office:document-content>
`
  const pictureEntries = images
    .map((image, index) =>
      image.bytes
        ? `<manifest:file-entry manifest:full-path="Pictures/${escapeXml(names[index]!)}" manifest:media-type="${escapeXml(image.mimeType || 'application/octet-stream')}"/>`
        : '',
    )
    .join('')
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
  ${pictureEntries}
</manifest:manifest>
`
  const zippable: Zippable = {
    mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }],
    'META-INF/manifest.xml': strToU8(manifest),
    'content.xml': strToU8(content),
    'styles.xml': strToU8(STYLES_XML),
  }
  images.forEach((image, index) => {
    if (image.bytes) zippable[`Pictures/${names[index]!}`] = copyBytes(image.bytes)
  })
  return zipSync(zippable)
}
