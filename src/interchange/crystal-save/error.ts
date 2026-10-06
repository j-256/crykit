export class CrystalSaveError extends Error {
  readonly offset: number | null

  constructor(message: string, offset: number | null = null) {
    super(offset === null ? message : `${message} at byte ${offset}`)
    this.name = 'CrystalSaveError'
    this.offset = offset
  }
}
