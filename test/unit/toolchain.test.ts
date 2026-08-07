import { atom, computed, context } from '@reatom/core'
import { beforeEach, describe, expect, it } from 'vitest'

beforeEach(() => context.reset())

describe('toolchain', () => {
  it('round-trips a named atom', () => {
    context.start(() => {
      const counter = atom(0, 'test.counter')

      expect(counter()).toBe(0)
      counter.set(2)
      expect(counter()).toBe(2)
    })
  })

  it('recomputes a derived value', () => {
    context.start(() => {
      const counter = atom(1, 'test.counter')
      const doubled = computed(() => counter() * 2, 'test.doubled')

      expect(doubled()).toBe(2)
      counter.set(21)
      expect(doubled()).toBe(42)
    })
  })
})
