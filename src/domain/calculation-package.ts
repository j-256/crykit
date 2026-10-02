import combatData from '../catalog/native-combat-v1.json' with { type: 'json' }
import combatRules from '../calculations/combat-v1.json' with { type: 'json' }
import combatParity from '../calculations/combat-parity-v1.json' with { type: 'json' }
import previewParity from '../calculations/preview-parity-v1.json' with { type: 'json' }
import combatExample from '../calculations/combat-example-v1.json' with { type: 'json' }
import enemyRules from '../calculations/enemy-difficulty-v1.json' with { type: 'json' }
import { calculationPackage as characterPackage } from './calculation-rules.ts'

// Loaded on export so combat reference data does not expand the startup bundle
export function calculationPackage(version: 1 | 2 = 2) {
  const character = characterPackage()
  if (version === 1) return character
  return {
    format: character.format,
    schemaVersion: 2,
    id: 'pc-1.6.9-package-v2',
    rules: character.rules,
    data: character.data,
    verification: character.verification,
    combat: combatRules,
    combatData,
    combatVerification: combatParity,
    previewVerification: previewParity,
    example: combatExample,
    enemy: enemyRules,
  }
}
