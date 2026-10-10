import type { MechanicsIssue } from '../domain/build-mechanics'

export const BUILD_REVIEW_FIELDS = { primaryClass: 'primary-class', secondaryClass: 'secondary-class', passives: 'passives' } as const

export function buildValidityGuidance(issue: MechanicsIssue, canUploadMod = false) {
  const targets = issue.slotId ? [issue.slotId] : []
  const unknown = issue.status === 'undetermined'
  if (issue.code === 'PASSIVE_DEFINITION' && !unknown) return { message: 'Choose an equippable passive for this field.', targets }
  switch (issue.code) {
    case 'CLASS_DEFINITION_UNAVAILABLE':
    case 'PASSIVE_DEFINITION':
    case 'EQUIPMENT_DEFINITION':
      return { message: canUploadMod ? 'Upload the matching mod JSON to restore this definition, or choose an available selection.' : 'Restore the missing definition from its source, or choose an available selection.', targets, importSource: unknown, reviewSetup: !canUploadMod }
    case 'CLASS_INNATE_DEFINITION':
      return { message: 'Upload the matching mod JSON to verify this class\'s active innates, or choose a class with known innate effects.', targets, importSource: true, reviewSetup: !canUploadMod }
    case 'CLASS_COMMAND_DEFINITION':
      return { message: 'Upload the matching mod JSON to restore the command and its ability definitions, or choose an available command.', targets, importSource: true, reviewSetup: !canUploadMod }
    case 'PASSIVE_LEARNABILITY_UNKNOWN':
      return { message: 'Upload the matching mod JSON to verify that this passive can be learned, or choose another equipped passive.', targets, importSource: true, reviewSetup: !canUploadMod }
    case 'CLASS_EQUIPMENT_PERMISSION':
    case 'DUAL_WIELD_REQUIRED':
    case 'EQUIPMENT_ALLOCATION_HANDS':
      return { message: unknown ? 'Restore the missing class and passive definitions to check their equipment permissions, or review those selections.' : 'Choose a class or passive that grants the required permission, or change the equipment.', targets: [BUILD_REVIEW_FIELDS.primaryClass, BUILD_REVIEW_FIELDS.passives, ...targets], importSource: unknown }
    case 'PP_COST_UNKNOWN':
      return { message: 'Restore the missing passive definitions or choose passives with known PP costs.', targets: [BUILD_REVIEW_FIELDS.passives], importSource: true }
    case 'PP_LIMIT_EXCEEDED':
      return { message: 'Remove or replace passives to fit the PP limit.', targets: [BUILD_REVIEW_FIELDS.passives] }
    case 'PP_LIMIT_UNKNOWN':
    case 'SLOT_ACCEPTANCE_UNKNOWN':
      return { message: 'Review this rule in Game Setup and supply the value for your game.', targets, reviewSetup: true }
    case 'SLOT_REFERENCE_MISSING':
      return { message: 'Remove the retained selection or restore its slot in Game Setup.', targets, reviewSetup: true }
    case 'CATALOG_REFERENCE_MISMATCH':
      return { message: 'Choose a definition from this Game Setup, or update the setup to use the intended source revision.', targets, reviewSetup: true }
    case 'DUPLICATE_PASSIVE':
      return { message: 'Remove or replace the repeated passive.', targets }
    case 'PASSIVE_NOT_LEARNABLE':
    case 'PASSIVE_NOT_EQUIPPABLE':
      return { message: 'Choose an equippable passive, or verify the mod and its selected revision in Game Setup.', targets, importSource: unknown, reviewSetup: true }
    case 'CLASS_DISABLED':
    case 'CLASS_KIND':
    case 'ENTITY_KIND_NOT_ACCEPTED':
      return { message: 'Choose an available definition of the kind accepted by this field.', targets }
    case 'EQUIPMENT_TYPE_UNKNOWN':
    case 'EQUIPMENT_ROLE_CONFLICT':
    case 'EQUIPMENT_REQUIREMENTS_CONFLICT':
    case 'HAND_OCCUPANCY_UNKNOWN':
      return { message: 'Inspect the equipment definition and its source rules; choose a verified alternative if the rule cannot be established.', targets, importSource: unknown, reviewSetup: true }
    case 'EQUIPMENT_ROLE':
      return { message: 'Move this item to a compatible slot or choose different equipment.', targets }
    case 'MIXED_EQUIPMENT_ALLOCATION':
    case 'EQUIPMENT_ALLOCATION_ROLES':
      return { message: 'Use separate item copies, or select the same item in the two hand slots.', targets }
    case 'TWO_HAND_CONFLICT':
      return { message: 'Remove the other hand item or share one copy across both hands.', targets }
    case 'UNIQUE_EQUIPMENT':
      return { message: 'Remove the extra equipped copy.', targets }
    default:
      return { message: 'Review the selected definition and the rules in Game Setup.', targets, reviewSetup: true }
  }
}
