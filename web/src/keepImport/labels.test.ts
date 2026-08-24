import { describe, expect, it } from 'vitest'
import { uniqueImportLabelName } from './labels'

describe('uniqueImportLabelName', () => {
  const now = new Date('2026-08-24T15:00:00')

  it('uses the local calendar date', () => {
    expect(uniqueImportLabelName([], now)).toBe('Google Keep import 2026-08-24')
  })

  it('adds (2) when the date label already exists', () => {
    expect(uniqueImportLabelName(['Google Keep import 2026-08-24'], now)).toBe(
      'Google Keep import 2026-08-24 (2)',
    )
  })
})
