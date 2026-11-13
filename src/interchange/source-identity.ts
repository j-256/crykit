import { validDeclaredProjectId } from '../domain/source-identity'
import { sha256 } from './sha256'
import { catalogContentForChecksum } from './catalog-checksum'
import type { CatalogSnapshot } from '../domain/types'

export async function crystalEditSourceKey(projectId: string): Promise<string> {
  if (!validDeclaredProjectId(projectId)) throw new Error('Invalid declared Crystal Edit project identity')
  // Hash a versioned tuple, not labels or delimiter-joined fields that can share an encoding
  const identity = ['crykit-source-key', 1, 'crystal-project', 'crystal-edit', projectId]
  return `ce1-${await sha256(new TextEncoder().encode(JSON.stringify(identity)))}`
}

export async function researchSourceKey(projectId: string | undefined, contentDigest: string): Promise<string> {
  if (projectId !== undefined && !validDeclaredProjectId(projectId)) throw new Error('Invalid declared research project identity')
  const digest = projectId === undefined ? contentDigest : await sha256(new TextEncoder().encode(JSON.stringify(['crykit-source-key', 1, 'crystal-project', 'research-json', projectId])))
  return `research1-${digest}`
}

export async function sealImportedCatalog(catalog: CatalogSnapshot): Promise<CatalogSnapshot> {
  const { checksum: _checksum, importedAt: _acquiredAt, ...content } = catalog
  return { ...content, checksum: `payload:sha256:${await sha256(new TextEncoder().encode(catalogContentForChecksum(content)))}` }
}
