import { describe, expect, it } from 'vitest'
import { parseDocument } from './document'
import { deriveInspectorFileInfo, readInspectorFileInfo, INSPECTOR_FILE_INFO_TEXT_LIMIT, inspectorInputFileInfo, withInspectorInputFileInfo } from './file-info'

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

  it('copies legacy optional hints into strict JSON without changing their meaning', () => {
    const info = readInspectorFileInfo(deriveInspectorFileInfo(parseDocument('{}'), false))!
    expect(Object.hasOwn(info, 'title')).toBe(true)
    const fields = withInspectorInputFileInfo({ unknown: '\ud800' }, info)
    expect(fields).toStrictEqual(JSON.parse(JSON.stringify(fields)))
    expect(inspectorInputFileInfo(fields)).toEqual(info)
    expect(info).toHaveProperty('title', undefined)
  })

  it('keeps display hints in inert input without replacing unknown values or future hint versions', () => {
    const info = deriveInspectorFileInfo(parseDocument('{"Title":"Bounded label","Version":"1"}'), false)
    const fields = { tab: 'map', unknown: { preserved: 'Exact input' } }
    const result = withInspectorInputFileInfo(fields, info)
    expect(result).toEqual({ ...fields, fileInfo: info })
    expect(inspectorInputFileInfo(result)).toEqual(info)
    expect(fields).toEqual({ tab: 'map', unknown: { preserved: 'Exact input' } })
    const future = { fileInfo: { schemaVersion: 9, unknown: 'Keep this exact cache' }, tab: 'map' }
    expect(withInspectorInputFileInfo(future, info)).toBe(future)
    expect(inspectorInputFileInfo(future)).toBeUndefined()
    for (const opaque of ['unknown input', [1, 2], 42]) {
      expect(withInspectorInputFileInfo(opaque, info)).toBe(opaque)
      expect(inspectorInputFileInfo(opaque)).toBeUndefined()
    }
  })
})
