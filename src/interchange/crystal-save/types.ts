export type BsonDocument = { type: 'document'; value: Record<string, BsonValue>; keys?: string[] }

export type BsonValue = BsonDocument
  | { type: 'array'; value: BsonValue[] }
  | { type: 'int32'; value: number }
  | { type: 'double'; value: number; raw?: Uint8Array }
  | { type: 'int64' | 'datetime'; value: bigint }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' }
  | { type: 'opaque'; bsonType: number; value: Uint8Array }

export interface CrystalSaveHeaderMember {
  isPresent: boolean
  name: string
  level: number
  genderId: number
  jobId: number
}

export interface CrystalSaveHeader {
  version: number
  invertedVersion?: boolean
  isDemo: boolean
  isHardcoreDefeat: boolean
  playTime: { days: number; hours: number; minutes: number; seconds: number; milliseconds: number }
  lastUpdated: { year: number; month: number; day: number; hour: number; minute: number; second: number } | null
  homePointName: string
  currencyAmount: number
  members: CrystalSaveHeaderMember[]
  difficultyId: number
  patchMode: number
  assistFlags: number
  challengeFlags: number
  randomizerFlags: number
  newGamePlusCount: number
  isModded: boolean
  mods: { id: string; title: string; version: string; steamWorkshopFileId: bigint }[]
  modIdMaps: { modId: string; groups: Record<string, { originalId: number; newId: number }[]> }[]
}

export interface CrystalSaveMap {
  id: number
  originX: number
  originY: number
  lengthX: number
  lengthY: number
  data: Uint8Array
}

export interface CrystalSave {
  originalBytes: Uint8Array
  header: CrystalSaveHeader
  party: BsonDocument
  members: BsonDocument[]
  maps: CrystalSaveMap[]
  combatBytes: Uint8Array
}
