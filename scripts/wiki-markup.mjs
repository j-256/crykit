const HTML_COMMENT_OPEN = '<!--'
const HTML_COMMENT_CLOSE = '-->'

export function stripHtmlComments(value) {
  let remaining = value
  while (remaining.includes(HTML_COMMENT_OPEN)) {
    let cursor = 0
    let sanitized = ''
    while (cursor < remaining.length) {
      const start = remaining.indexOf(HTML_COMMENT_OPEN, cursor)
      if (start < 0) {
        sanitized += remaining.slice(cursor)
        break
      }
      sanitized += remaining.slice(cursor, start)
      const end = remaining.indexOf(HTML_COMMENT_CLOSE, start + HTML_COMMENT_OPEN.length)
      if (end < 0) {
        cursor = remaining.length
        break
      }
      cursor = end + HTML_COMMENT_CLOSE.length
    }
    remaining = sanitized
  }
  return remaining
}

export function stripHtmlTags(value) {
  let cursor = 0
  let sanitized = ''
  while (cursor < value.length) {
    const start = value.indexOf('<', cursor)
    if (start < 0) {
      sanitized += value.slice(cursor)
      break
    }
    sanitized += value.slice(cursor, start)
    const end = value.indexOf('>', start + 1)
    if (end < 0) {
      sanitized += value.slice(start)
      break
    }
    cursor = end + 1
  }
  return sanitized
}
