import { useEffect, useRef } from 'react'
import type { PublicEnrichment } from '../interchange/public-share-enrichment'
import { publicRefKey, type PublicRef, type PublicSnapshot } from '../interchange/public-share-schema'
import { PublicSelectionEvidence } from './PublicShareSources'
import { CatalogArtwork } from './WikiSprite'
import { Icon } from './icons'

export function publicSelectionName(snapshot: PublicSnapshot, ref: PublicRef | null | undefined, empty = 'Empty'): string {
  return ref ? snapshot.receipts.find(receipt => publicRefKey(receipt.ref) === publicRefKey(ref))?.name ?? 'Unresolved selection' : empty
}

export function publicMemberName(snapshot: PublicSnapshot, index: number): string {
  return snapshot.slots[index]?.name ?? `Member ${index + 1}`
}

export function PublicShareRoster({ snapshot, enrichment, selected, onSelect }: { readonly snapshot: PublicSnapshot; readonly enrichment?: PublicEnrichment; readonly selected: number; readonly onSelect: (index: number) => void }) {
  const roster = useRef<HTMLOListElement>(null)
  const members = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    const strip = roster.current, member = members.current[selected]
    if (!strip || !member) return
    // Move only the roster; scrollIntoView also moves the page beneath its sticky header
    const bounds = strip.getBoundingClientRect(), card = member.getBoundingClientRect()
    if (card.left < bounds.left) strip.scrollLeft += card.left - bounds.left
    else if (card.right > bounds.right) strip.scrollLeft += card.right - bounds.right
  }, [selected])
  return <nav aria-label="Team members" className="share-roster"><ol ref={roster}>{snapshot.slots.map((slot, index) => {
    const name = publicMemberName(snapshot, index)
    const primary = slot?.primaryClass && enrichment?.entries.find(entry => publicRefKey(entry.receipt.ref) === publicRefKey(slot.primaryClass!))
    const gear = slot?.equipment.filter(entry => entry.ref).map(entry => publicSelectionName(snapshot, entry.ref)) ?? []
    return <li key={index}><section aria-label={`Shared team slot ${index + 1}`}><button ref={element => { members.current[index] = element }} aria-label={slot ? `View ${name}` : `View empty slot ${index + 1}`} aria-pressed={selected === index} className="share-roster__member" onClick={() => onSelect(index)} type="button">
      <span className="share-roster__identity"><span aria-hidden="true" className="share-roster__portrait">{primary?.definition && primary.viewerRef?.kind === 'catalog' ? <CatalogArtwork compact catalogId={primary.viewerRef.catalogId} catalogRevisionId={primary.viewerRef.catalogRevisionId} entity={{ ...primary.definition, id: primary.viewerRef.entityId }}/>: <Icon name="character"/>}</span><span><small>Member {index + 1}</small><strong>{slot ? name : 'Empty slot'}</strong></span></span>
      {slot ? <><span className="share-roster__class">{publicSelectionName(snapshot, slot.primaryClass, 'No class selected')}{slot.secondaryClass && <> / {publicSelectionName(snapshot, slot.secondaryClass)}</>}</span><span className="share-roster__gear">{gear.length ? gear.join(' · ') : 'No equipment selected'}</span></> : <span className="share-roster__gear">No build assigned</span>}
    </button></section></li>
  })}</ol><div className="share-roster__paging" role="group" aria-label="Team member navigation"><button type="button" aria-label="Previous member" title="Previous member" disabled={selected === 0} onClick={() => onSelect(selected - 1)}><Icon name="arrow-left"/></button><span role="status">Member {selected + 1} of {snapshot.slots.length}</span><button type="button" aria-label="Next member" title="Next member" disabled={selected === snapshot.slots.length - 1} onClick={() => onSelect(selected + 1)}><Icon name="arrow-right"/></button></div></nav>
}

// Receipts supply display names only; mechanics come exclusively from exact enrichment entries
export function PublicShareLoadout({ snapshot, index, enrichment }: { readonly snapshot: PublicSnapshot; readonly index: number; readonly enrichment?: PublicEnrichment }) {
  const slot = snapshot.slots[index]
  if (!slot) return <p className="share-empty-member">No build in this slot.</p>
  const selection = (label: string, ref: PublicRef | null, empty = 'Empty') => {
    const entry = ref ? enrichment?.entries.find(entry => publicRefKey(entry.receipt.ref) === publicRefKey(ref)) : undefined
    return <div className="share-receipt-selection" data-empty={!ref || undefined}><span className="share-receipt-selection__label">{label}</span>{ref ? <details><summary><strong>{publicSelectionName(snapshot, ref)}</strong>{!entry?.definition && <small>Mechanics unknown</small>}</summary><PublicSelectionEvidence entry={entry}/></details> : <span className="share-receipt-selection__empty">{empty}</span>}</div>
  }
  const notes = snapshot.notes?.slots[index]
  const slotLabel = (id: string) => snapshot.setup.slots.find(display => display.id === id)?.label ?? id
  return <div className="share-receipt-loadout">
    <section aria-label="Class and command" className="build-sheet__group"><h3><Icon name="crystal"/>Class &amp; command</h3><div className="share-receipt-classes">{selection('Class', slot.primaryClass, 'No class selected')}{selection('Sub-command', slot.secondaryClass, 'No sub-command')}</div></section>
    <section aria-label="Equipment" className="build-sheet__group"><h3><Icon name="sword"/>Equipment</h3><div className="build-sheet__equipment">{slot.equipment.map(entry => <div key={entry.slotId}>{selection(slotLabel(entry.slotId), entry.ref)}</div>)}</div>{slot.equipmentGroups.map((group, groupIndex) => <p className="field__hint" key={groupIndex}>Same physical copy: {group.map(slotLabel).join(', ')}</p>)}</section>
    <section aria-label="Passives" className="build-sheet__group"><h3><Icon name="spark"/>Equipped passives</h3>{slot.passives.length ? slot.passives.map((ref, passiveIndex) => <div key={passiveIndex}>{selection(`Passive ${passiveIndex + 1}`, ref)}</div>) : <p className="field__hint">No passives equipped.</p>}</section>
    {notes && (notes.checkpoint || notes.rotationNotes || notes.contextAssumptions.length > 0) && <section className="share-notes"><h3>Build notes and assumptions</h3>{notes.checkpoint && <p>{notes.checkpoint}</p>}{notes.rotationNotes && <p>{notes.rotationNotes}</p>}{notes.contextAssumptions.map((note, noteIndex) => <p key={noteIndex}>{note}</p>)}</section>}
  </div>
}
