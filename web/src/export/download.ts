export function downloadNoteFile(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function printNoteHtml(html: string) {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.append(iframe)
  const cleanup = () => iframe.remove()
  iframe.addEventListener('load', () => {
    iframe.contentWindow?.focus()
    iframe.contentWindow?.print()
    iframe.contentWindow?.addEventListener('afterprint', cleanup)
    window.setTimeout(cleanup, 60_000)
  })
  iframe.srcdoc = html
}
