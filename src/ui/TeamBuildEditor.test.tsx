import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { addTestBuild, createTestLocalData, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import { TeamBuildEditor } from './BuildsView'
import { DefinitionProvider } from './definitions'
import { NavigationProvider, type NavigationController } from './navigation'
const navigation = { route: { page: { page: 'teams', view: 'new' }, overlays: [], query: {} }, registerBlocker: () => () => undefined } as unknown as NavigationController

describe('Team-owned member editor', () => {
  it('edits content under the chosen shared setup without source Build metadata controls', () => {
    const data = addTestBuild(createTestLocalData(), 'source', '', {})
    const markup = renderToStaticMarkup(<NavigationProvider controller={navigation}><DefinitionProvider catalogs={[]} localData={data} onSaveDefinition={async () => { throw new Error('Unexpected definition save') }}><TeamBuildEditor localData={data} catalogs={[]} gameSetupRevisionId={TEST_GAME_SETUP_REVISION_ID} sourceRevision={data.buildRevisions['source-revision']} onCancel={() => undefined} onDraftChange={() => undefined} onSubmit={async () => { throw new Error('Unexpected save') }}/></DefinitionProvider></NavigationProvider>)
    expect(markup).toContain('Save member and return to Team')
    expect(markup).toContain('Class &amp; command')
    expect(markup).toContain('Shared Team Game Setup')
    expect(markup).toContain('aria-label="Member name"')
    expect(markup).not.toContain('Build title')
    expect(markup).not.toContain('Copy Game Setup')
  })
})
