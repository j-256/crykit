import snapshot from './native-game-data.json' with { type: 'json' }
import travelIdentities from './game-travel-identities.json' with { type: 'json' }
import type { CatalogSnapshot } from '../domain/types'
import { assembleNativeBase, type NativeGameSnapshot } from '../domain/native-game'

const nativeSnapshot = snapshot as unknown as NativeGameSnapshot
const travelHash = nativeSnapshot.source.files.find(file => file.path === `Database/${travelIdentities.database}.dat`)?.sha256
if (travelHash !== travelIdentities.databaseSha256) throw new Error('Travel item identity evidence does not match the native database')
const travelBindings = Object.fromEntries(travelIdentities.records.map(record => [`${travelIdentities.database}:${record.databaseId}`, record.id]))
for (const [key, id] of Object.entries(travelBindings)) if (nativeSnapshot.identityBindings[key] && nativeSnapshot.identityBindings[key] !== id) throw new Error(`Conflicting reviewed travel identity: ${key}`)
export const NATIVE_GAME_DATA: NativeGameSnapshot = { ...nativeSnapshot, identityBindings: { ...nativeSnapshot.identityBindings, ...travelBindings } }

export function addNativeBase(supplement: CatalogSnapshot): CatalogSnapshot {
  return assembleNativeBase(supplement, NATIVE_GAME_DATA)
}
