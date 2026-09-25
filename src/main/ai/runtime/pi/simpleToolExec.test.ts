import { describe, expect, it } from 'vitest'

import { isSimpleToolExecCode } from './simpleToolExec'

describe('isSimpleToolExecCode', () => {
  it.each([
    'return tools.invoke("mcp__browser__open", { url: "https://artbin.web/es/", timeout: 20000 });',
    "return await tools.invoke('mcp__browser__snapshot', {})",
    'return tools.invoke("mcp__server__ping")',
    'await tools.invoke("a", { list: [1, -2.5, "x", true, null, { nested: [] }], "quoted-key": "v", })',
    'const page = await tools.invoke("a", { id: 1 })\nreturn page',
    'const a = await tools.invoke("a", {}); const b = await tools.invoke("b", { x: "it\\"s" }); return b.items.first',
    'await tools.invoke("a", {}); await tools.invoke("b", {})'
  ])('accepts literal-only tool calls: %s', (code) => {
    expect(isSimpleToolExecCode(code)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['non-string', 42],
    ['require', 'const fs = require("node:fs"); return fs.readdirSync("/")'],
    ['dynamic import', 'return import("node:child_process")'],
    ['computed argument', 'return tools.invoke("a", { url: "x" + "y" })'],
    ['template literal', 'return tools.invoke(`a`, {})'],
    ['identifier argument', 'return tools.invoke("a", { p: process })'],
    ['comment', 'return tools.invoke("a", {}) // hi'],
    ['other method', 'return tools.constructor("return process")()'],
    ['loop', 'for (const x of [1]) await tools.invoke("a", {})'],
    ['statement after return', 'return tools.invoke("a", {}); tools.invoke("b", {})'],
    ['undeclared return', 'return globalThis'],
    ['prototype access', 'const r = await tools.invoke("a", {}); return r.constructor'],
    ['proto key', 'return tools.invoke("a", { __proto__: { x: 1 } })'],
    ['shadow tools', 'const tools = await tools.invoke("a", {})'],
    ['call on result', 'const r = await tools.invoke("a", {}); return r.x()'],
    ['unterminated string', 'return tools.invoke("a, {})'],
    ['assignment', 'let r = await tools.invoke("a", {}); r = 1']
  ])('rejects %s', (_label, code) => {
    expect(isSimpleToolExecCode(code)).toBe(false)
  })
})
