import { describe, expect, it } from 'vitest'

import { parseLines } from '../AgentToolApprovalSettings'

describe('parseLines', () => {
  it('trims entries and drops blank lines and duplicates', () => {
    expect(parseLines('  tool_exec \n\nnpm run\ntool_exec\n  ')).toEqual(['tool_exec', 'npm run'])
  })

  it('returns an empty list for empty text', () => {
    expect(parseLines('')).toEqual([])
  })
})
