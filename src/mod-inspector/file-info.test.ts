import { describe, expect, it } from 'vitest'
import { parseDocument } from './document'
import { deriveInspectorFileInfo, readInspectorFileInfo, INSPECTOR_FILE_INFO_TEXT_LIMIT } from './file-info'

describe('inspector file presentation metadata', () => {
  it('reads exact root strings without interpreting document identity', () => {
    const text = '\ufeff{"Title":" Synthetic title ","Version":"01.0","ID":"Private ID","Unknown":900719925474099312345}\r\n'
    const document = parseDocument(text)
    const info = deriveInspectorFileInfo(document, false)
    expect(info).toMatchObject({ schemaVersion: 1, title: 'Synthetic title', version: '01.0', projectId: 'Private ID', titleState: 'present', versionState: 'present', projectIdState: 'present', edited: false })
    expect(document.text).toBe(text)
    expect(readInspectorFileInfo(info)).toEqual(info)
  })

  it('distinguishes absent and malformed fields and ignores nested lookalikes', () => {
    expect(deriveInspectorFileInfo(parseDocument('{"Title":null,"Version":34,"nested":{"ID":"other"}}'), true)).toEqual({ schemaVersion: 1, titleState: 'invalid', versionState: 'invalid', projectIdState: 'missing', edited: true })
    expect(deriveInspectorFileInfo(parseDocument('{"Title":"  ","Version":{},"ID":[]}'), false)).toMatchObject({ titleState: 'invalid', versionState: 'invalid', projectIdState: 'invalid' })
  })

  it('bounds presentation only and rejects invalid or unsupported cached formats', () => {
    const title = 'a'.repeat(INSPECTOR_FILE_INFO_TEXT_LIMIT + 50)
    const document = parseDocument(JSON.stringify({ Title: title }))
    const info = deriveInspectorFileInfo(document, false)
    expect(info.title).toHaveLength(INSPECTOR_FILE_INFO_TEXT_LIMIT)
    expect(info.title?.endsWith('...')).toBe(true)
    const whitespace = deriveInspectorFileInfo(parseDocument(JSON.stringify({ ID: ' '.repeat(500) + title + '  ' })), false)
    expect(whitespace.projectId).toBe(info.title)
    expect(document.text).toContain(title)
    for (const cache of [null, {}, { ...info, schemaVersion: 2 }, { ...info, edited: 'false' }, { ...info, title }, { ...info, titleState: 'missing' }, { ...info, title: '   ' }]) expect(readInspectorFileInfo(cache)).toBeUndefined()
  })
})
