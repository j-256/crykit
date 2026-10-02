import { expect, it } from 'vitest'
import { steamWorkshopFileId, steamWorkshopItemUrl } from './mod-workshop'

it('links explicit positive Workshop IDs and leaves missing or invalid IDs unknown', () => {
  expect(steamWorkshopFileId(3055060437)).toBe('3055060437')
  expect(steamWorkshopItemUrl('3055060437')).toBe('https://steamcommunity.com/sharedfiles/filedetails/?id=3055060437')
  for (const value of [undefined, null, 0, '0', -1, '01', 1.5, Number.MAX_SAFE_INTEGER + 1, 'javascript:alert(1)', '3055060437&extra=1']) expect(steamWorkshopItemUrl(value)).toBeUndefined()
})
