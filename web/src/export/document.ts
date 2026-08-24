import { Lexer, lexer, type Token, type Tokens } from 'marked'
import { preprocessMarkdown } from '../markdown/preprocessMarkdown'
import type { Note } from '../types'
import { stripMarkdownImages } from './markdown'
import type {
  BlockNode,
  ExportDocument,
  InlineMark,
  InlineNode,
  ListItemNode,
} from './types'

function withMark(nodes: InlineNode[], mark: InlineMark): InlineNode[] {
  return nodes.map((node) => {
    if (node.type === 'text') {
      const marks = [...new Set([...(node.marks ?? []), mark])]
      return { ...node, marks }
    }
    if (node.type === 'link') {
      return { ...node, children: withMark(node.children, mark) }
    }
    return node
  })
}

function htmlFragmentToInlines(html: string): InlineNode[] {
  if (typeof DOMParser === 'undefined') {
    return [{ type: 'text', text: html.replace(/<[^>]+>/g, '') }]
  }
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  return walkHtml(doc.body)
}

function walkHtml(node: Node): InlineNode[] {
  const out: InlineNode[] = []
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? ''
      if (text) out.push({ type: 'text', text })
      return
    }
    if (!(child instanceof HTMLElement)) return
    const tag = child.tagName.toLowerCase()
    if (tag === 'br') {
      out.push({ type: 'br' })
      return
    }
    const children = walkHtml(child)
    if (tag === 'strong' || tag === 'b') out.push(...withMark(children, 'bold'))
    else if (tag === 'em' || tag === 'i') out.push(...withMark(children, 'italic'))
    else if (tag === 'u') out.push(...withMark(children, 'underline'))
    else if (tag === 'del' || tag === 's') out.push(...withMark(children, 'strike'))
    else if (tag === 'code') out.push(...withMark(children, 'code'))
    else if (tag === 'sub') out.push(...withMark(children, 'sub'))
    else if (tag === 'sup') out.push(...withMark(children, 'sup'))
    else if (tag === 'a') {
      const href = child.getAttribute('href') ?? ''
      out.push({ type: 'link', href, children: children.length ? children : [{ type: 'text', text: href }] })
    } else out.push(...children)
  })
  return out
}

function tokensToInlines(tokens: Token[] | undefined): InlineNode[] {
  if (!tokens?.length) return []
  const out: InlineNode[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const textToken = token as Token & { tokens?: Token[]; text: string }
        if (textToken.tokens?.length) out.push(...tokensToInlines(textToken.tokens))
        else if (textToken.text) out.push({ type: 'text', text: textToken.text })
        break
      }
      case 'strong':
        out.push(...withMark(tokensToInlines(token.tokens), 'bold'))
        break
      case 'em':
        out.push(...withMark(tokensToInlines(token.tokens), 'italic'))
        break
      case 'del':
        out.push(...withMark(tokensToInlines(token.tokens), 'strike'))
        break
      case 'codespan':
        out.push({ type: 'text', text: token.text, marks: ['code'] })
        break
      case 'link':
        out.push({
          type: 'link',
          href: token.href,
          children: tokensToInlines(token.tokens).length
            ? tokensToInlines(token.tokens)
            : [{ type: 'text', text: token.text }],
        })
        break
      case 'image':
        break
      case 'br':
        out.push({ type: 'br' })
        break
      case 'escape':
        out.push({ type: 'text', text: token.text })
        break
      case 'html':
      case 'tag':
        out.push(...htmlFragmentToInlines('text' in token ? String(token.text) : token.raw))
        break
      default:
        if ('tokens' in token && Array.isArray(token.tokens)) {
          out.push(...tokensToInlines(token.tokens))
        } else if ('text' in token && typeof token.text === 'string' && token.text) {
          out.push({ type: 'text', text: token.text })
        }
    }
  }
  return out
}

export function parseInlineMarkdown(markdown: string): InlineNode[] {
  const prepared = preprocessMarkdown(stripMarkdownImages(markdown))
  if (!prepared.trim()) return []
  return tokensToInlines(Lexer.lexInline(prepared))
}

function firstParagraphInlines(tokens: Token[] | undefined): InlineNode[] {
  if (!tokens?.length) return []
  for (const token of tokens) {
    if (token.type === 'paragraph') return tokensToInlines(token.tokens)
    if (token.type === 'text') {
      return token.tokens?.length ? tokensToInlines(token.tokens) : token.text ? [{ type: 'text', text: token.text }] : []
    }
  }
  return tokensToInlines(tokens)
}

function convertBlocks(tokens: Token[]): BlockNode[] {
  const blocks: BlockNode[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break
      case 'heading': {
        const level = Math.min(6, Math.max(1, token.depth)) as 1 | 2 | 3 | 4 | 5 | 6
        blocks.push({ type: 'heading', level, inlines: tokensToInlines(token.tokens) })
        break
      }
      case 'paragraph': {
        const inlines = tokensToInlines(token.tokens)
        if (inlines.length) blocks.push({ type: 'paragraph', inlines })
        break
      }
      case 'code':
        blocks.push({ type: 'code', lang: token.lang, text: token.text })
        break
      case 'blockquote': {
        const quote = token as Tokens.Blockquote
        blocks.push({ type: 'blockquote', blocks: convertBlocks(quote.tokens ?? []) })
        break
      }
      case 'hr':
        blocks.push({ type: 'hr' })
        break
      case 'list': {
        const list = token as Tokens.List
        const items: ListItemNode[] = list.items.map((item) => {
          const nestedTokens = item.tokens.filter(
            (child) => child.type === 'list' || child.type === 'blockquote' || child.type === 'code',
          )
          const nested = nestedTokens.length ? convertBlocks(nestedTokens) : undefined
          return { inlines: firstParagraphInlines(item.tokens), nested }
        })
        blocks.push({ type: 'list', ordered: list.ordered, items })
        break
      }
      case 'table': {
        const table = token as Tokens.Table
        const header = table.header.map((cell) => tokensToInlines(cell.tokens))
        const rows = table.rows.map((row) => row.map((cell) => tokensToInlines(cell.tokens)))
        blocks.push({ type: 'table', header, rows })
        break
      }
      case 'html': {
        const inlines = htmlFragmentToInlines(token.text)
        if (inlines.length) blocks.push({ type: 'paragraph', inlines })
        break
      }
      default:
        if ('tokens' in token && Array.isArray(token.tokens)) {
          blocks.push(...convertBlocks(token.tokens))
        }
    }
  }
  return blocks
}

function inlinesToPlain(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return node.text
      if (node.type === 'br') return '\n'
      return inlinesToPlain(node.children)
    })
    .join('')
}

function blocksToPlain(blocks: BlockNode[], lines: string[]) {
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        lines.push(inlinesToPlain(block.inlines), '')
        break
      case 'paragraph':
        lines.push(inlinesToPlain(block.inlines), '')
        break
      case 'code':
        lines.push(block.text, '')
        break
      case 'hr':
        lines.push('---', '')
        break
      case 'blockquote':
        blocksToPlain(block.blocks, lines)
        break
      case 'list':
        block.items.forEach((item, index) => {
          const bullet = block.ordered ? `${index + 1}. ` : '- '
          lines.push(`${bullet}${inlinesToPlain(item.inlines)}`)
          if (item.nested) blocksToPlain(item.nested, lines)
        })
        lines.push('')
        break
      case 'checklist':
        for (const item of block.items) {
          const indent = '  '.repeat(item.indent)
          const mark = item.checked ? 'x' : ' '
          lines.push(`${indent}[${mark}] ${inlinesToPlain(item.inlines)}`)
        }
        lines.push('')
        break
      case 'table': {
        const formatRow = (row: InlineNode[][]) => row.map((cell) => inlinesToPlain(cell)).join('\t')
        if (block.header.length) lines.push(formatRow(block.header))
        for (const row of block.rows) lines.push(formatRow(row))
        lines.push('')
        break
      }
    }
  }
}

export function buildExportDocument(note: Note): ExportDocument {
  const title = note.title.trim()
  const blocks: BlockNode[] = []
  if (title) {
    blocks.push({ type: 'heading', level: 1, inlines: [{ type: 'text', text: title }] })
  }
  if (note.type === 'LIST') {
    blocks.push({
      type: 'checklist',
      items: note.items.map((item) => ({
        checked: item.checked,
        indent: item.indent ?? 0,
        inlines: parseInlineMarkdown(item.text),
      })),
    })
  } else {
    const prepared = preprocessMarkdown(stripMarkdownImages(note.contentRaw))
    if (prepared.trim()) blocks.push(...convertBlocks(lexer(prepared)))
  }
  return { title, blocks }
}

export function documentToPlainText(doc: ExportDocument): string {
  const lines: string[] = []
  blocksToPlain(doc.blocks, lines)
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '')
  return text ? `${text}\n` : ''
}

export function noteToPlainText(note: Note): string {
  return documentToPlainText(buildExportDocument(note))
}

export function inlinesToPlainText(nodes: InlineNode[]): string {
  return inlinesToPlain(nodes)
}
