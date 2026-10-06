import { type SaveEditorFamily, type SaveEditorMode } from '../save-editor-mods'
import { type CrystalSave } from '../../interchange/crystal-save.ts'

export const SAVE_EDITOR_MAX_CURRENCY = 999_999_999

export const DEFAULT_LEVEL_CAP = 60

export const SAVE_EDITOR_MAX_LEVEL = 99

export const MAX_JP = 10_000

export const PASSIVE_POINT_BUDGET = 10

export const LEGACY_HEADER = Object.freeze({ flags: 14, mods: 24 })

export const LEVEL_ASSIST_FLAG = 128

export const EMPTY_DATE = -62_135_596_800_000n

export const LEARNED = Object.freeze({ locked: 0, unlocked: 1, learned: 2 })

export const ATLAS = Object.freeze({ seen: 2, acquired: 4 })

export type Family = SaveEditorFamily

export type SaveInventoryKind = 'item' | 'equipment'

export interface SaveEditorChoice { id: number; name: string }

export interface SaveEditorMemberSummary { index: number; name: string; level: number; jobId: number; subJobId: number | null; growthJobId: number; equipmentIds: readonly (number | null)[]; passiveIds: readonly number[]; unlockedJobIds: readonly number[]; learnedPassiveIds: readonly number[]; unlockedJobs: number; masteredJobs: number; learnedAbilities: number; learnedPassives: number }

export interface SaveEditorInventoryRow extends SaveEditorChoice { kind: SaveInventoryKind; count: number; capacity: number; equipped: number }

export interface SaveEditorSummary { editable: boolean; issues: string[]; mode: SaveEditorMode; randomized: boolean; currency: number; members: SaveEditorMemberSummary[]; inventory: SaveEditorInventoryRow[]; levelCap: number; assistEnabled: boolean }

export interface SaveVanillaConversionPreview { relevant: boolean; convertible: boolean; changes: readonly string[]; blockers: readonly string[]; draft?: CrystalSave }

export type SaveEditCommand =
  | { type: 'currency'; value: number }
  | { type: 'member'; index: number; name?: string; level?: number; jobId?: number; subJobId?: number | null }
  | { type: 'loadout'; index: number; jobId: number; subJobId: number | null; equipmentIds: readonly (number | null)[]; passiveIds: readonly number[] }
  | { type: 'stock'; kind: SaveInventoryKind; id: number; count: number }
  | { type: 'unlock-jobs' | 'master-jobs' | 'overpowered' | 'reveal-maps' }
