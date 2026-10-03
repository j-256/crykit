import { ACQUISITION_CONDITION_DATA_KEYS } from '../../src/domain/item-acquisition.ts'

const LOOT_FAMILIES = Object.freeze({ Item: 'item', Equipment: 'equipment' })
const CONDITION_KEYS = new Set(ACQUISITION_CONDITION_DATA_KEYS)
const NEVER = Object.freeze({ type: 'Never', negated: false, data: {} })

export function acquisitionCondition(condition, invert = false) {
  if (!condition || typeof condition.ConditionType !== 'string') return { type: 'Unresolved', negated: invert, data: {} }
  const data = {}
  for (const [key, value] of Object.entries(condition.Data ?? {})) {
    if (key === 'LHS' || key === 'RHS') data[key] = acquisitionCondition(value)
    else if (CONDITION_KEYS.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) data[key] = value
  }
  return { type: condition.ConditionType, negated: Boolean(condition.IsNegation) !== invert, data }
}

export function projectWorldAcquisition(entities, system) {
  const entries = []
  const familyFor = type => LOOT_FAMILIES[type]
  const add = (family, targetID, entry) => {
    if (family && Number.isSafeInteger(targetID) && targetID >= 0) entries.push({ family, targetID, ...entry })
  }
  for (const entity of entities) {
    const place = { entityID: entity.ID, biomeID: entity.BiomeID, coord: entity.Coord }
    if (entity.EntityType === 'Treasure') {
      const loot = entity.TreasureData
      add(familyFor(loot.LootType), loot.LootValue, { kind: 'chest', ...place, label: 'Treasure chest', path: '/TreasureData', conditions: [] })
    }
    if (entity.EntityType !== 'Npc') continue
    const npc = entity.NpcData
    const names = [...new Set(npc.Outfits.map(outfit => outfit.Name).filter(name => typeof name === 'string' && name.trim()))]
    const label = names.length === 1 ? names[0] : 'NPC'
    const visibility = npc.Outfits.map(outfit => acquisitionCondition(outfit.Condition))
    const visible = visibility.length ? visibility.reduce((left, right) => ({ type: 'Operation', negated: false, data: { LHS: left, Op: 'Or', RHS: right } })) : NEVER
    const visit = (actions, path, conditions, costs = []) => {
      let precedingCosts = [...costs]
      for (const [index, action] of actions.entries()) {
        const locator = `${path}/${index}`
        const data = action.Data ?? {}
        if (action.ActionType === 'Condition') {
          visit(data.ConditionActionsTrue ?? [], `${locator}/Data/ConditionActionsTrue`, [...conditions, acquisitionCondition(data.Condition)], precedingCosts)
          visit(data.ConditionActionsFalse ?? [], `${locator}/Data/ConditionActionsFalse`, [...conditions, acquisitionCondition(data.Condition, true)], precedingCosts)
        } else if (action.ActionType === 'CommandNpc') {
          visit(data.Actions ?? [], `${locator}/Data/Actions`, [...conditions, { type: 'RemoteInteraction', negated: false, data: {} }], precedingCosts)
        } else if (action.ActionType === 'RemoveInventory') {
          if (data.Count > 0 && familyFor(data.LootType)) precedingCosts.push({ family: familyFor(data.LootType), id: data.LootValue, count: data.Count })
        } else if (action.ActionType === 'AddInventory' || action.ActionType === 'AddToLostAndFound') {
          if (data.Count > 0) add(familyFor(data.LootType), data.LootValue, { kind: action.ActionType === 'AddInventory' ? 'reward' : 'recovery', ...place, label, path: locator, conditions, count: data.Count, costs: [...precedingCosts], redirects: !data.Redirect })
        } else if (action.ActionType === 'Shop' || action.ActionType === 'ShopRecipe') {
          for (const [stockIndex, stock] of (data.Stock ?? []).entries()) {
            add(action.ActionType === 'ShopRecipe' ? 'recipe' : familyFor(stock.LootType), stock.LootValue, { kind: action.ActionType === 'ShopRecipe' ? 'craft' : 'shop', ...place, label, path: `${locator}/Data/Stock/${stockIndex}`, conditions: [...conditions, acquisitionCondition(stock.Condition)], costRate: stock.CostRate })
          }
        } else if (['StopProcessing', 'TriggerNpc', 'FutureActions', 'InsertFutureActions', 'QueueFutureActions', 'ContextSwitch'].includes(action.ActionType)) {
          conditions = [...conditions, { type: 'InteractionSequence', negated: false, data: {} }]
          precedingCosts = []
        }
      }
    }
    npc.Pages.forEach((page, pageIndex) => {
      const higher = npc.Pages.slice(pageIndex + 1).filter(other => other.TriggerType === page.TriggerType && other.Actions.length)
      const conditions = [visible, acquisitionCondition(page.Condition), ...higher.map(other => acquisitionCondition(other.Condition, true))]
      if (page.TriggerType !== 'PlayerAction') conditions.push({ type: 'InteractionTrigger', negated: false, data: {} })
      visit(page.Actions, `/NpcData/Pages/${pageIndex}/Actions`, conditions)
    })
  }
  for (const [index, loot] of (system.StartingLoot ?? []).entries()) add(loot.LootType === 1 ? 'item' : loot.LootType === 2 ? 'equipment' : undefined, loot.LootID, { kind: 'start', label: 'Starting inventory', path: `/StartingLoot/${index}`, conditions: [], count: loot.LootQuantity })
  return entries.filter(entry => !entry.conditions.some(condition => condition.type === NEVER.type && !condition.negated || condition.type === 'Always' && condition.negated))
}
