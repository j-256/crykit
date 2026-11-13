import { validDeclaredProjectId } from '../domain/source-identity'
import { sha256 } from './sha256'

export async function crystalEditSourceKey(projectId: string): Promise<string> {
  if (!validDeclaredProjectId(projectId)) throw new Error('Invalid declared Crystal Edit project identity')
  // Hash a versioned tuple, not labels or delimiter-joined fields that can share an encoding
  const identity = ['crykit-source-key', 1, 'crystal-project', 'crystal-edit', projectId]
  return `ce1-${await sha256(new TextEncoder().encode(JSON.stringify(identity)))}`
}
