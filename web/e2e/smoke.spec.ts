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

  await page.route('**/api/labels', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill({ json: [] })
      return
    }
    void route.continue()
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

test('signs in and creates a text note', async ({ page }) => {
  await signInAndOpenEditor(page)
  await page.getByLabel('Note title').fill('Smoke test note')
  await page.getByRole('tab', { name: 'Markdown' }).click()
  await page.getByLabel('Note content').fill('Created by Playwright')
  await expect(page.getByText(/Unsaved changes|Saving|Saved/)).toBeVisible()
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
