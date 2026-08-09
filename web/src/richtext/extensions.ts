import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import Document from '@tiptap/extension-document'
import Image from '@tiptap/extension-image'
import Italic from '@tiptap/extension-italic'
import Link from '@tiptap/extension-link'
import Paragraph from '@tiptap/extension-paragraph'
import Placeholder from '@tiptap/extension-placeholder'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import { TableKit } from '@tiptap/extension-table'
import Underline from '@tiptap/extension-underline'
import Strike from '@tiptap/extension-strike'
import Text from '@tiptap/extension-text'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import type { Extensions } from '@tiptap/core'
import { i18n } from '../i18n'

const markdownExtension = Markdown.configure({
  html: true,
  tightLists: true,
  bulletListMarker: '-',
  linkify: false,
  breaks: false,
  transformPastedText: true,
  transformCopiedText: true,
})

const linkExtension = Link.configure({
  openOnClick: false,
  HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
})

/** Single-paragraph document for checklist item lines. */
const InlineDocument = Document.extend({
  content: 'paragraph',
})

export function blockExtensions(
  placeholder = i18n.t('editor.contentPlaceholder'),
): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      codeBlock: {},
      horizontalRule: {},
      blockquote: {},
      bulletList: {},
      orderedList: {},
      listItem: {},
      strike: {},
      code: {},
      link: false,
      underline: false,
    }),
    linkExtension,
    Underline,
    Subscript,
    Superscript,
    Image.configure({ inline: false, allowBase64: false }),
    TableKit.configure({
      table: { resizable: false },
    }),
    Placeholder.configure({ placeholder }),
    markdownExtension,
  ]
}

export function inlineExtensions(
  placeholder = i18n.t('editor.itemPlaceholder'),
): Extensions {
  return [
    InlineDocument,
    Paragraph,
    Text,
    Bold,
    Italic,
    Strike,
    Code,
    Underline,
    Subscript,
    Superscript,
    linkExtension,
    Placeholder.configure({ placeholder }),
    markdownExtension,
  ]
}
