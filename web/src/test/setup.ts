import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { bootstrapI18n } from '../i18n'

bootstrapI18n()

afterEach(() => cleanup())

class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'IntersectionObserver', {
  value: MockIntersectionObserver,
  writable: true,
})

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  value: MockResizeObserver,
  writable: true,
})

if (!('locks' in navigator)) {
  Object.defineProperty(navigator, 'locks', {
    value: {
      request: async (
        _name: string,
        optionsOrCallback: unknown,
        maybeCallback?: (lock: { name: string }) => Promise<void> | void,
      ) => {
        const callback =
          typeof optionsOrCallback === 'function'
            ? (optionsOrCallback as (lock: { name: string }) => Promise<void> | void)
            : maybeCallback
        await callback?.({ name: 'test' })
      },
    },
    configurable: true,
  })
}