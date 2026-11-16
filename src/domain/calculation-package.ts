import modifiers from '../calculations/native-modifiers-v1.json' with { type: 'json' }
import modifierVerification from '../calculations/modifier-parity-v1.json' with { type: 'json' }
import combatData from '../catalog/native-combat-v1.json' with { type: 'json' }
import combatRules from '../calculations/combat-v1.json' with { type: 'json' }
import combatParity from '../calculations/combat-parity-v1.json' with { type: 'json' }
import previewParity from '../calculations/preview-parity-v1.json' with { type: 'json' }
import combatExample from '../calculations/combat-example-v1.json' with { type: 'json' }
import enemyRules from '../calculations/enemy-difficulty-v1.json' with { type: 'json' }
import characterVerification from '../calculations/pc-parity-v1.json' with { type: 'json' }
import { PC_RULES, NATIVE_DATA } from './calculation-rules.ts'

// Loaded on export so export-only verification data does not expand the startup bundle
export function calculationPackage() {
  return {
    format: 'crystal-project-calculations',
    schemaVersion: 1,
    id: 'crystal-project-calculations-v1',
    rules: PC_RULES,
    data: NATIVE_DATA,
    verification: characterVerification,
    combat: combatRules,
    combatData,
    combatVerification: combatParity,
    previewVerification: previewParity,
    example: combatExample,
    enemy: enemyRules,
    modifiers,
    modifierVerification,
  }
}
