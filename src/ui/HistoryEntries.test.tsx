import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChangeEntry } from '../domain/types'
import { HistoryEntries } from './HistoryEntries'

function entry(command: string): ChangeEntry {
  return { id: 'synthetic-history' as ChangeEntry['id'], command, previousRevision: 1, nextRevision: 2, changedPaths: ['/playthroughs/synthetic/inventory'], recordedAt: '2026-10-01T12:00:00.000Z' as ChangeEntry['recordedAt'] }
}

describe('readable change history', () => {
  it.each(['__proto__', 'constructor', 'toString', 'synthetic.unknown-command'])('retains imported command %s without treating inherited keys as labels', (command) => {
    const markup = renderToStaticMarkup(<HistoryEntries changes={[entry(command)]}/>)
    expect(markup).toContain('<strong>Change saved</strong>')
    expect(markup).toContain(`<code>${command}</code>`)
    expect(markup).toContain('/playthroughs/synthetic/inventory')
    expect(markup).toContain('revision 2')
  })

  it('gives a known command a readable title while retaining its original identifier', () => {
    const markup = renderToStaticMarkup(<HistoryEntries changes={[entry('inventory.observe.create')]}/>)
    expect(markup).toContain('<strong>Inventory item recorded</strong>')
    expect(markup).toContain('<code>inventory.observe.create</code>')
  })
})
