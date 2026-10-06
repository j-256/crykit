// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SHORT_TEXT_LENGTH } from '../domain/limits'
import { BuildTitleInput } from './BuildTitleInput'

const FORM_ID = 'synthetic-build-editor'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('Build title header input', () => {
  it('associates the header with its external form and retains required versus optional submission', async () => {
    const submitted = vi.fn()
    const render = (required: boolean) => <>
      <BuildTitleInput disabled={false} formId={FORM_ID} onChange={() => undefined} required={required ? true : undefined} value=""/>
      <form id={FORM_ID} onSubmit={event => { event.preventDefault(); submitted() }}/>
    </>
    await act(async () => root.render(render(true)))
    const input = container.querySelector('input')!
    const form = container.querySelector('form')!
    expect(input.form).toBe(form)
    expect(form.contains(input)).toBe(false)
    expect([...form.elements]).toContain(input)
    expect(input.validity.valueMissing).toBe(true)
    await act(async () => form.requestSubmit())
    expect(submitted).not.toHaveBeenCalled()

    await act(async () => root.render(render(false)))
    expect(form.checkValidity()).toBe(true)
    await act(async () => form.requestSubmit())
    expect(submitted).toHaveBeenCalledOnce()
  })

  it('reports raw edits to the owner and reflects only the supplied controlled value', async () => {
    const onChange = vi.fn()
    const render = (value: string) => <BuildTitleInput disabled={false} formId={FORM_ID} onChange={onChange} value={value}/>
    await act(async () => root.render(render('Original Build')))
    const input = container.querySelector('input')!
    const draft = '  Draft Build  '
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, draft)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledExactlyOnceWith(draft)
    expect(input.value).toBe('Original Build')
    await act(async () => root.render(render(draft)))
    expect(input.value).toBe(draft)
    expect(container.querySelector('h1')!.getAttribute('aria-label')).toBe('Draft Build')
  })

  it('keeps focus on the surrounding workflow through mount and title updates', async () => {
    const other = document.createElement('button')
    document.body.append(other)
    try {
      other.focus()
      const render = (value: string) => <StrictMode><BuildTitleInput disabled={false} formId={FORM_ID} onChange={() => undefined} value={value}/></StrictMode>
      await act(async () => root.render(render('Original Build')))
      expect(document.activeElement).toBe(other)
      await act(async () => root.render(render('Updated Build')))
      expect(document.activeElement).toBe(other)
    } finally { other.remove() }
  })

  it('excludes a disabled title from native validation and exposes fallback and help without altering its draft', async () => {
    const hint = 'Renaming updates this Build in every Team that uses it.'
    const render = (disabled: boolean) => <BuildTitleInput disabled={disabled} fallback="Member Build" formId={FORM_ID} hint={hint} onChange={() => undefined} required value=""/>
    await act(async () => root.render(render(true)))
    const input = container.querySelector('input')!
    expect(input.disabled).toBe(true)
    expect(input.willValidate).toBe(false)
    expect(input.checkValidity()).toBe(true)
    expect(input.required).toBe(true)
    expect(input.maxLength).toBe(MAX_SHORT_TEXT_LENGTH)
    expect(input.getAttribute('aria-label')).toBe('Build title')
    expect(input.getAttribute('aria-description')).toBe(hint)
    expect(input.title).toBe(hint)
    expect(input.placeholder).toBe('Member Build')
    expect(container.querySelector('h1')!.getAttribute('aria-label')).toBe('Member Build')
    await act(async () => root.render(render(false)))
    expect(input.value).toBe('')
    expect(input.willValidate).toBe(true)
    expect(input.checkValidity()).toBe(false)
  })
})
