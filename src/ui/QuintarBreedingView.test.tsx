import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { QUINTAR_BREEDING_STEPS, QUINTAR_GOLD_STEP_ID, QUINTAR_STEP } from '../catalog/quintar-breeding'
import { requirePlaythrough, toggleQuintarStep } from '../domain'
import { createTestLocalData } from '../domain/test-helpers'
import type { LocalData } from '../domain/types'
import { NavigationProvider, useNavigationController } from './navigation'
import { QuintarBreedingView } from './QuintarBreedingView'

function Harness({ localData }: { readonly localData: LocalData }) {
  const navigation = useNavigationController()
  return <NavigationProvider controller={navigation}><QuintarBreedingView catalogs={[DEFAULT_CATALOG]} localData={localData} onToggle={async () => undefined}/></NavigationProvider>
}
const render = (localData: LocalData) => renderToStaticMarkup(<Harness localData={localData}/>)

describe('Quintar guide presentation', () => {
  it('shows practical locations, native record links, and one compact source control', () => {
    const markup = render(createTestLocalData())
    expect(markup).toContain('east of Yamagawa M.A. or northwest of Dione Shrine')
    expect(markup).toContain('Overpass northwest of Okimoto N.S. or north of Sara Sara Beach')
    expect(markup).toContain('northwest of Triton Shrine')
    expect(markup).toContain('nests northeast or northwest of Sara Sara Bazaar')
    expect(markup).toContain('Quintar Mausoleum under the Quintar Reserve')
    expect(markup).toContain('quintar shopkeeper in Dione Shrine')
    expect(markup).toContain('Trusty Quintar (Blue)')
    expect(markup).toContain('Incubator')
    expect(markup.match(/aria-label="Quintar guide sources"/g)).toHaveLength(1)
    expect(markup).not.toMatch(/native plan|reviewed|assumptions|without assuming|confirm them in your nursery/i)
    expect(markup).toContain(`data-step="${QUINTAR_GOLD_STEP_ID}"`)
  })

  it('keeps generated-route records distinct from the established route checkmarks', () => {
    const original = createTestLocalData()
    const priorRecipe = 'native-pairing-v1:brutish-gold:fancy-aqua+woke-black' as const
    const saved = toggleQuintarStep(original, { stepId: priorRecipe, playthroughId: requirePlaythrough(original).id })
    const before = JSON.stringify(saved)
    const markup = render(saved)
    expect(markup).toContain('Earlier route records preserved')
    expect(markup).toContain('retains 1 completed step')
    expect(markup).toContain('checkmarks remain saved separately')
    expect(markup).toContain(`<strong>0</strong><span> / ${QUINTAR_BREEDING_STEPS.length}`)
    expect(markup).not.toContain('data-complete="true"')
    expect(JSON.stringify(saved)).toBe(before)
    const next = toggleQuintarStep(saved, { stepId: QUINTAR_STEP.golden, playthroughId: requirePlaythrough(saved).id })
    expect(Object.keys(requirePlaythrough(next).quintarBreeding!)).toEqual([priorRecipe, QUINTAR_STEP.golden])
    expect(render(next)).toContain('data-complete="true"')
  })
})
