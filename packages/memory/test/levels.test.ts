import { describe, expect, it } from 'vitest'
import { RELATION_LEVELS } from '../src/index.js'

describe('RELATION_LEVELS', () => {
  it('从家人到路人共五级', () => {
    expect(RELATION_LEVELS).toEqual(['L0', 'L1', 'L2', 'L3', 'L4'])
  })
})
