import { expect, type Page } from '@playwright/test'

export function teamCheckpointControl(page: Page, slotNumber: number) {
  return page.getByRole('button', { name: `Choose checkpoint for Team slot ${slotNumber}`, exact: true })
}

export async function chooseTeamCheckpoint(page: Page, slotNumber: number, revisionId?: string) {
  await teamCheckpointControl(page, slotNumber).click()
  const dialog = page.getByRole('dialog', { name: `Choose checkpoint for Team slot ${slotNumber}`, exact: true })
  await dialog.getByRole('checkbox', { name: 'Show sample builds', exact: true }).check()
  await dialog.getByRole('searchbox', { name: 'Search build checkpoints', exact: false }).fill('')
  const choices = dialog.getByRole('list', { name: 'Build checkpoints', exact: true }).getByRole('button')
  await (revisionId ? dialog.locator(`button[data-revision-id="${revisionId}"]`) : choices.first()).click()
  await expect(dialog).not.toBeVisible()
}
