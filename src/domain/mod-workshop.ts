export const CRYSTAL_PROJECT_WORKSHOP_URL = 'https://steamcommunity.com/workshop/browse/?appid=1637730'

export function steamWorkshopFileId(value: unknown): string | undefined {
  const id = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : ''
  return /^[1-9]\d{0,19}$/.test(id) ? id : undefined
}

export function steamWorkshopItemUrl(value: unknown): string | undefined {
  const id = steamWorkshopFileId(value)
  return id ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}` : undefined
}
