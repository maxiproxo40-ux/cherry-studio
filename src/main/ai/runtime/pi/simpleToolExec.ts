/**
 * Recognizes `tool_exec` code that does nothing but call tools with literal arguments.
 *
 * `tool_exec` runs model-written JavaScript in a worker that is NOT a security sandbox, so it is
 * approval-gated in every mode below Full Access. Most real calls are trivial wrappers such as
 * `return tools.invoke("mcp__browser__open", { url: "https://…" })`, and every nested
 * `tools.invoke` is already authorized individually by the pi tool authorizer. For that shape the
 * outer prompt adds nothing, so the authorizer may skip it and let the nested policy decide.
 *
 * The check is an allowlist grammar, not a denylist: anything outside it (comments, templates,
 * function calls other than `tools.invoke`, operators, control flow, computed values) is rejected
 * and keeps the ordinary approval prompt.
 *
 *   program   := stmt+
 *   stmt      := ('return' | ('const' | 'let') IDENT '=')? invoke ';'?
 *              | 'return' IDENT ('.' IDENT)* ';'?          // only a variable declared above
 *   invoke    := 'await'? 'tools' '.' 'invoke' '(' STRING (',' literal)? ','? ')'
 *   literal   := STRING | '-'? NUMBER | 'true' | 'false' | 'null'
 *              | '{' (key ':' literal (',' key ':' literal)* ','?)? '}'
 *              | '[' (literal (',' literal)* ','?)? ']'
 *   key       := IDENT | STRING
 *
 * A `return` statement must be the last statement.
 */

type Token =
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'punct'; value: string }

const MAX_CODE_LENGTH = 20_000
const MAX_STATEMENTS = 20
const MAX_LITERAL_DEPTH = 32
const PUNCTUATION = new Set(['(', ')', '{', '}', '[', ']', ',', ':', ';', '.', '=', '-'])
const RESERVED_NAMES = new Set(['tools', '__proto__', 'constructor', 'prototype'])

function tokenize(code: string): Token[] | undefined {
  const tokens: Token[] = []
  let i = 0
  while (i < code.length) {
    const ch = code[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1
      while (j < code.length && /[\w$]/.test(code[j])) j++
      tokens.push({ kind: 'ident', value: code.slice(i, j) })
      i = j
      continue
    }
    if (/[0-9]/.test(ch)) {
      const match = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(code.slice(i))
      if (!match) return undefined
      const end = i + match[0].length
      // Reject things like `1abc` or `1.` that are not a plain decimal number.
      if (end < code.length && /[\w$.]/.test(code[end])) return undefined
      tokens.push({ kind: 'number', value: match[0] })
      i = end
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      let value = ''
      while (j < code.length && code[j] !== ch) {
        if (code[j] === '\n' || code[j] === '\r') return undefined
        if (code[j] === '\\') {
          if (j + 1 >= code.length) return undefined
          value += code[j] + code[j + 1]
          j += 2
          continue
        }
        value += code[j]
        j++
      }
      if (j >= code.length) return undefined
      tokens.push({ kind: 'string', value })
      i = j + 1
      continue
    }
    if (PUNCTUATION.has(ch)) {
      tokens.push({ kind: 'punct', value: ch })
      i++
      continue
    }
    // Backticks, slashes (comments / regex / division), operators, backslashes outside strings, …
    return undefined
  }
  return tokens
}

class Parser {
  private pos = 0
  private readonly declared = new Set<string>()

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): boolean {
    let statements = 0
    while (this.pos < this.tokens.length) {
      if (++statements > MAX_STATEMENTS) return false
      const result = this.parseStatement()
      if (result === 'invalid') return false
      if (result === 'return') return this.pos === this.tokens.length
    }
    return statements > 0
  }

  private parseStatement(): 'ok' | 'return' | 'invalid' {
    if (this.acceptIdent('return')) {
      if (this.peekIsInvoke()) {
        if (!this.parseInvoke()) return 'invalid'
      } else if (!this.parseVariableAccess()) {
        return 'invalid'
      }
      this.acceptPunct(';')
      return 'return'
    }

    if (this.acceptIdent('const') || this.acceptIdent('let')) {
      const name = this.next()
      if (name?.kind !== 'ident' || RESERVED_NAMES.has(name.value) || isKeyword(name.value)) return 'invalid'
      if (this.declared.has(name.value)) return 'invalid'
      if (!this.acceptPunct('=')) return 'invalid'
      if (!this.parseInvoke()) return 'invalid'
      this.declared.add(name.value)
      this.acceptPunct(';')
      return 'ok'
    }

    if (!this.parseInvoke()) return 'invalid'
    this.acceptPunct(';')
    return 'ok'
  }

  private peekIsInvoke(): boolean {
    const token = this.tokens[this.pos]
    return token?.kind === 'ident' && (token.value === 'await' || token.value === 'tools')
  }

  private parseInvoke(): boolean {
    this.acceptIdent('await')
    if (!this.acceptIdent('tools')) return false
    if (!this.acceptPunct('.')) return false
    if (!this.acceptIdent('invoke')) return false
    if (!this.acceptPunct('(')) return false
    if (this.next()?.kind !== 'string') return false
    if (this.acceptPunct(',')) {
      if (this.acceptPunct(')')) return true
      if (!this.parseLiteral(0)) return false
      this.acceptPunct(',')
    }
    return this.acceptPunct(')')
  }

  private parseVariableAccess(): boolean {
    const name = this.next()
    if (name?.kind !== 'ident' || !this.declared.has(name.value)) return false
    while (this.acceptPunct('.')) {
      const property = this.next()
      if (property?.kind !== 'ident' || RESERVED_NAMES.has(property.value)) return false
    }
    return true
  }

  private parseLiteral(depth: number): boolean {
    if (depth > MAX_LITERAL_DEPTH) return false
    const token = this.next()
    if (!token) return false
    if (token.kind === 'string' || token.kind === 'number') return true
    if (token.kind === 'ident') return token.value === 'true' || token.value === 'false' || token.value === 'null'
    if (token.value === '-') return this.next()?.kind === 'number'
    if (token.value === '[') {
      if (this.acceptPunct(']')) return true
      do {
        if (this.peekPunct(']')) break
        if (!this.parseLiteral(depth + 1)) return false
      } while (this.acceptPunct(','))
      return this.acceptPunct(']')
    }
    if (token.value === '{') {
      if (this.acceptPunct('}')) return true
      do {
        if (this.peekPunct('}')) break
        const key = this.next()
        if (!key || (key.kind !== 'ident' && key.kind !== 'string')) return false
        if (RESERVED_NAMES.has(key.value) && key.value !== 'tools') return false
        if (!this.acceptPunct(':')) return false
        if (!this.parseLiteral(depth + 1)) return false
      } while (this.acceptPunct(','))
      return this.acceptPunct('}')
    }
    return false
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++]
  }

  private peekPunct(value: string): boolean {
    const token = this.tokens[this.pos]
    return token?.kind === 'punct' && token.value === value
  }

  private acceptPunct(value: string): boolean {
    if (!this.peekPunct(value)) return false
    this.pos++
    return true
  }

  private acceptIdent(value: string): boolean {
    const token = this.tokens[this.pos]
    if (token?.kind !== 'ident' || token.value !== value) return false
    this.pos++
    return true
  }
}

const KEYWORDS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield'
])

function isKeyword(name: string): boolean {
  return KEYWORDS.has(name)
}

/** True when `code` only calls `tools.invoke` with literal arguments (see the grammar above). */
export function isSimpleToolExecCode(code: unknown): boolean {
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_LENGTH) return false
  const tokens = tokenize(code)
  if (!tokens || tokens.length === 0) return false
  return new Parser(tokens).parseProgram()
}
