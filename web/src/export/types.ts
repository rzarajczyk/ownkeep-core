export type InlineMark = 'bold' | 'italic' | 'strike' | 'code' | 'underline' | 'sub' | 'sup'

export type InlineNode =
  | { type: 'text'; text: string; marks?: InlineMark[] }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'br' }

export interface ListItemNode {
  inlines: InlineNode[]
  nested?: BlockNode[]
}

export type BlockNode =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: InlineNode[] }
  | { type: 'paragraph'; inlines: InlineNode[] }
  | { type: 'list'; ordered: boolean; items: ListItemNode[] }
  | { type: 'checklist'; items: Array<{ checked: boolean; indent: number; inlines: InlineNode[] }> }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'blockquote'; blocks: BlockNode[] }
  | { type: 'table'; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: 'hr' }

export interface ExportDocument {
  title: string
  blocks: BlockNode[]
}

export interface ExportBinary {
  filename: string
  mimeType: string
  bytes: Uint8Array | null
}

export type ExportFormat = 'md' | 'md-zip' | 'html' | 'txt' | 'odt' | 'docx' | 'rtf' | 'print'
