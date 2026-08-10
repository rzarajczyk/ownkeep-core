import { describe, expect, it } from 'vitest'
import { isNewerMutation } from './lww'

describe('isNewerMutation', () => {
  it('prefers later clientUpdatedAt', () => {
    expect(
      isNewerMutation(
        { clientUpdatedAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { clientUpdatedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      ),
    ).toBe(true)
  })

  it('breaks ties with clientMutationId', () => {
    expect(
      isNewerMutation(
        {
          clientUpdatedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          clientMutationId: 'b',
        },
        {
          clientUpdatedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          clientMutationId: 'a',
        },
      ),
    ).toBe(true)
  })
})
