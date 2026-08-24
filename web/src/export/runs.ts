import type { InlineMark, InlineNode } from './types'

export interface TextRun {
  text: string
  marks: InlineMark[]
  href?: string
}

export function flattenRuns(nodes: InlineNode[], inherited: InlineMark[] = [], href?: string): TextRun[] {
  const runs: TextRun[] = []
  for (const node of nodes) {
    if (node.type === 'br') {
      runs.push({ text: '\n', marks: inherited, href })
      continue
    }
    if (node.type === 'link') {
      runs.push(...flattenRuns(node.children, inherited, node.href || href))
      continue
    }
    const marks = [...new Set([...inherited, ...(node.marks ?? [])])]
    if (node.text) runs.push({ text: node.text, marks, href })
  }
  return runs
}

export function hasMark(run: TextRun, mark: InlineMark): boolean {
  return run.marks.includes(mark)
}
