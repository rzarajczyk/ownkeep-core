import { expect, test, type Page } from '@playwright/test'

const uninitializedVault = {
  kdfSalt: null,
  kdfParams: null,
  wrappedVaultKey: null,
  wrappedVaultKeyRecovery: null,
  hasRecoveryKey: false,
  initialized: false,
  needsRecoveryUnlock: false,
}

const demoUser = {
  id: 1,
  email: 'demo@example.com',
  role: 'USER' as const,
  vault: uninitializedVault,
}

async function mockApi(page: Page) {
  let vault = { ...uninitializedVault }
  const labels: Array<{ id: string; ciphertext: string; createdAt: string; updatedAt: string }> = []

  await page.route('**/api/auth/login', (route) =>
    route.fulfill({
      json: {
        token: 'smoke-token',
        expiresAt: '2099-01-01T00:00:00Z',
        user: { ...demoUser, vault },
      },
    }),
  )

  // Register /me before /me/vault so the more specific route wins (last match).
  await page.route(/.*\/api\/me$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill({
      json: { ...demoUser, vault },
    })
  })

  await page.route('**/api/me/vault', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const body = route.request().postDataJSON() as {
      kdfSalt: string
      kdfParams: typeof vault.kdfParams
      wrappedVaultKey: string
      wrappedVaultKeyRecovery: string
    }
    vault = {
      kdfSalt: body.kdfSalt,
      kdfParams: body.kdfParams,
      wrappedVaultKey: body.wrappedVaultKey,
      wrappedVaultKeyRecovery: body.wrappedVaultKeyRecovery,
      hasRecoveryKey: true,
      initialized: true,
      needsRecoveryUnlock: false,
    }
    await route.fulfill({ json: vault })
  })

  await page.route('**/api/labels', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: labels })
      return
    }
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { ciphertext: string }
      const label = {
        id: crypto.randomUUID(),
        ciphertext: payload.ciphertext,
        createdAt: '2026-07-12T12:00:00Z',
        updatedAt: '2026-07-12T12:00:00Z',
      }
      labels.push(label)
      await route.fulfill({ status: 200, json: label })
      return
    }
    await route.continue()
  })

  await page.route(/.*\/api\/notes\?.*/, (route) =>
    route.fulfill({
      json: {
        items: [],
        deletedIds: [],
        nextUpdatedAfter: null,
        nextAfterId: null,
        hasMore: false,
      },
    }),
  )

  await page.route('**/api/notes', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const payload = route.request().postDataJSON() as {
      id: string
      type: string
      backgroundColor: string
      archived: boolean
      pinned: boolean
      wrappedNoteKey: string
      ciphertext: string
      labelIds: string[]
    }
    await route.fulfill({
      status: 200,
      json: {
        ...payload,
        labelIds: payload.labelIds ?? [],
        attachments: [],
        createdAt: '2026-07-12T12:00:00Z',
        updatedAt: '2026-07-12T12:00:00Z',
        version: 1,
      },
    })
  })

  await page.route(/.*\/api\/notes\/[^/?]+$/, async (route) => {
    const method = route.request().method()
    if (method !== 'PATCH' && method !== 'GET') {
      await route.continue()
      return
    }
    const payload =
      method === 'PATCH'
        ? (route.request().postDataJSON() as Record<string, unknown>)
        : {}
    const url = route.request().url()
    const id = decodeURIComponent(url.split('/').pop()!)
    await route.fulfill({
      status: 200,
      json: {
        id,
        type: 'TEXT',
        backgroundColor: '#ffffff',
        archived: false,
        pinned: false,
        labelIds: [],
        attachments: [],
        createdAt: '2026-07-12T12:00:00Z',
        updatedAt: '2026-07-12T12:00:01Z',
        version: 2,
        ...payload,
      },
    })
  })

  await page.route('**/api/markdown/preview', async (route) => {
    await route.fulfill({ status: 404, json: { error: 'not found' } })
  })
}

test.beforeEach(async ({ page }) => {
  await mockApi(page)
})

async function signInAndOpenEditor(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email').fill('demo@example.com')
  await page.getByLabel('Password').fill('password')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('heading', { name: 'Save your recovery key' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByRole('button', { name: 'I saved it — continue' }).click()

  await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible()
  await page.getByLabel('Add note').getByRole('button', { name: 'Add note' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

async function finishNote(page: Page, title: string, label?: string) {
  await page.getByLabel('Note title').fill(title)
  if (label) {
    await page.getByRole('button', { name: 'Add label' }).click()
    await page.getByPlaceholder('Create new label').fill(label)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Close editor' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.getByText(title, { exact: true })).toBeVisible()
}

test('signs in and creates a text note', async ({ page }) => {
  await signInAndOpenEditor(page)
  await page.getByRole('tab', { name: 'Markdown' }).click()
  await page.getByLabel('Note content').fill('Created by Playwright')
  await finishNote(page, 'Smoke test note')
})

test('batch edits selected notes from desktop hover controls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'desktop hover interaction')
  await signInAndOpenEditor(page)
  await finishNote(page, 'Batch first', 'Work')
  await page.getByLabel('Add note').getByRole('button', { name: 'Add note' }).click()
  await finishNote(page, 'Batch second')

  const firstCard = page.getByRole('article', { name: 'Batch first' })
  await firstCard.hover()
  await expect(page.getByRole('checkbox', { name: 'Select Batch first' })).toBeVisible()
  await page.getByRole('checkbox', { name: 'Select Batch first' }).click()

  const toolbar = page.getByRole('toolbar', { name: 'Batch edit selected notes' })
  await expect(toolbar.getByText('1 selected')).toBeVisible()
  await toolbar.getByRole('button', { name: 'Select all notes in this view' }).click()
  await expect(toolbar.getByText('2 selected')).toBeVisible()

  await toolbar.getByRole('button', { name: 'Edit labels' }).click()
  await page.getByRole('checkbox', { name: /^Add Work/ }).click()
  await expect(page.getByText('Added “Work” to 1 note')).toBeVisible()
  await expect(firstCard.getByText('Work')).toBeVisible()
  await expect(page.getByRole('article', { name: 'Batch second' }).getByText('Work')).toBeVisible()

  await toolbar.getByRole('button', { name: 'Edit labels' }).click()
  await page.getByRole('button', { name: 'Remove label' }).click()
  await page.getByRole('button', { name: /^Remove Work/ }).click()
  await expect(page.getByText('Removed “Work” from 2 notes')).toBeVisible()

  await toolbar.getByRole('button', { name: 'Change note color' }).click()
  await page.getByRole('button', { name: 'Yellow' }).click()
  await expect(page.getByText('Color changed for 2 notes')).toBeVisible()

  await toolbar.getByRole('button', { name: 'Archive selected notes' }).click()
  await expect(page.getByText('2 notes archived')).toBeVisible()
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(page.getByText('Batch first', { exact: true })).toBeVisible()
  await page.getByRole('article', { name: 'Batch first' }).hover()
  await page.getByRole('checkbox', { name: 'Select Batch first' }).click()
  await page.getByRole('toolbar', { name: 'Batch edit selected notes' })
    .getByRole('button', { name: 'Select all notes in this view' })
    .click()
  await page.getByRole('toolbar', { name: 'Batch edit selected notes' })
    .getByRole('button', { name: 'Restore selected notes' })
    .click()
  await expect(page.getByText('2 notes restored')).toBeVisible()
})

test('enters batch mode with a long press on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile long-press interaction')
  await signInAndOpenEditor(page)
  await finishNote(page, 'Long press me')

  const card = page.getByRole('article', { name: 'Long press me' })
  await card.dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 1,
    clientX: 40,
    clientY: 160,
    bubbles: true,
  })
  await page.waitForTimeout(550)
  await card.dispatchEvent('pointerup', {
    pointerType: 'touch',
    pointerId: 1,
    clientX: 40,
    clientY: 160,
    bubbles: true,
  })

  await expect(page.getByRole('toolbar', { name: 'Batch edit selected notes' })).toBeVisible()
  await expect(page.getByText('1 selected')).toBeVisible()
  await expect(page.getByRole('dialog')).not.toBeVisible()
})

test('keeps the mobile editor close control inset from the sheet edge', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'regression is full-bleed mobile layout')
  await page.addInitScript(() => {
    localStorage.setItem('ownkeep.language', 'pl')
  })
  await page.goto('/')
  await page.getByLabel('E-mail').fill('demo@example.com')
  await page.getByLabel('Hasło').fill('password')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()

  await expect(page.getByRole('heading', { name: 'Zapisz swój klucz odzyskiwania' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByRole('button', { name: 'Zapisałem go — kontynuuj' }).click()

  await expect(page.getByRole('heading', { name: 'Twoje notatki' })).toBeVisible()
  await page.getByLabel('Dodaj notatkę').getByRole('button', { name: 'Dodaj notatkę' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Edycja wizualna' })).toBeVisible()

  const close = page.getByRole('button', { name: 'Zamknij edytor' })
  const dialogBox = await dialog.boundingBox()
  const closeBox = await close.boundingBox()
  expect(dialogBox).toBeTruthy()
  expect(closeBox).toBeTruthy()
  const inset = dialogBox!.x + dialogBox!.width - (closeBox!.x + closeBox!.width)
  expect(inset).toBeGreaterThanOrEqual(16)
  await page.screenshot({
    path: testInfo.outputPath('editor-close-inset.png'),
    fullPage: false,
  })
})
