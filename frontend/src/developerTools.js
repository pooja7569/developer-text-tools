import { parse, stringify, isLosslessNumber, LosslessNumber } from 'lossless-json'
import { parseDocument, isAlias, isMap, isSeq, isScalar } from 'yaml'

export const INPUT_LIMIT = 256 * 1024
const MAX_DEPTH = 64
const MAX_NODES = 10000
export const jsonText = (value) => stringify(value, null, 2)
export const pointerPart = (key) => String(key).replaceAll('~', '~0').replaceAll('/', '~1')

export function checkInput(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Enter some input first.')
  if (new TextEncoder().encode(text).length > INPUT_LIMIT) {
    throw new Error('Input must not exceed 256 KiB.')
  }
}

export function kind(value) {
  if (isLosslessNumber(value)) return 'number'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

export function inspectValue(value) {
  const rows = []
  function walk(item, path, depth) {
    if (depth > MAX_DEPTH || rows.length >= MAX_NODES) {
      throw new Error('Data is too complex: maximum 64 levels and 10,000 values.')
    }
    const type = kind(item)
    rows.push({ path, type, value: type === 'object' || type === 'array'
      ? `${Object.keys(item).length} entries` : stringify(item) })
    if (type === 'object' || type === 'array') {
      for (const [key, child] of Object.entries(item)) {
        walk(child, `${path}/${pointerPart(key)}`, depth + 1)
      }
    }
  }
  walk(value, '', 0)
  return rows
}

export function parseJson(text) {
  checkInput(text)
  let depth = 0
  let quoted = false
  let escaped = false
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{' || char === '[') {
      if (++depth > MAX_DEPTH) throw new Error('JSON exceeds 64 nesting levels.')
    } else if (char === '}' || char === ']') depth--
  }
  let value
  try {
    value = parse(text)
  } catch (error) {
    const position = /position (\d+)/.exec(error.message)
    const prefix = position ? text.slice(0, Number(position[1])) : ''
    const line = prefix.split('\n').length
    const column = prefix.length - prefix.lastIndexOf('\n')
    throw new SyntaxError(`${error.message}${position ? ` (line ${line}, column ${column})` : ''}`)
  }
  inspectValue(value)
  return value
}

export function formatJsonSafe(text) {
  return jsonText(parseJson(text))
}

export function jsonToYaml(text) {
  const value = parseJson(text)
  function emit(item, depth) {
    const indent = '  '.repeat(depth)
    const type = kind(item)
    if ((type !== 'array' && type !== 'object') || Object.keys(item).length === 0) {
      return indent + stringify(item)
    }
    return Object.entries(item).map(([key, child]) => {
      const prefix = type === 'array' ? '-' : `${JSON.stringify(key)}:`
      const nested = ['object', 'array'].includes(kind(child)) && Object.keys(child).length > 0
      return indent + prefix + (nested ? '\n' + emit(child, depth + 1) : ' ' + stringify(child))
    }).join('\n')
  }
  return emit(value, 0) + '\n'
}

export function yamlToJson(text) {
  checkInput(text)
  const document = parseDocument(text, {
    version: '1.2', uniqueKeys: true, intAsBigInt: true, strict: true,
  })
  if (document.errors.length || document.warnings.length) {
    throw new Error((document.errors[0] || document.warnings[0]).message)
  }
  let nodes = 0
  function convert(node, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('YAML is too complex.')
    if (node === null) return null
    if (isAlias(node) || node.tag) {
      throw new Error('YAML aliases and explicit tags are not supported. Use plain JSON-compatible YAML.')
    }
    if (isMap(node)) {
      const result = Object.create(null)
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
          throw new Error('YAML mapping keys must be strings.')
        }
        result[pair.key.value] = convert(pair.value, depth + 1)
      }
      return result
    }
    if (isSeq(node)) return node.items.map((item) => convert(item, depth + 1))
    if (!isScalar(node)) throw new Error('Unsupported YAML value.')
    if (typeof node.value === 'bigint') return new LosslessNumber(String(node.value))
    if (typeof node.value === 'number') {
      if (!Number.isFinite(node.value)) throw new Error('Non-finite YAML numbers are not JSON-compatible.')
      let source = node.source.replaceAll('_', '').replace(/^\+/, '')
      source = source.replace(/^(-?)\./, '$10.').replace(/\.(?=[eE]|$)/, '.0')
      source = source.replace(/^(-?)0+(\d)/, '$1$2')
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(source)) {
        throw new Error('Unsupported YAML number spelling.')
      }
      return new LosslessNumber(source)
    }
    return node.value
  }
  const result = convert(document.contents, 0)
  inspectValue(result)
  return jsonText(result)
}

function canonicalNumber(value) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value.value)
  let digits = (match[2] + (match[3] || '')).replace(/^0+/, '')
  if (!digits) return '0'
  let exponent = BigInt(match[4] || '0') - BigInt((match[3] || '').length)
  const trailing = /0+$/.exec(digits)?.[0].length || 0
  digits = digits.slice(0, digits.length - trailing)
  exponent += BigInt(trailing)
  return `${match[1]}${digits}e${exponent}`
}

export function parseIgnoreRules(text) {
  const paths = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (paths.length > 100 || paths.some((path) =>
    !path.startsWith('/') || /~(?![01])/.test(path) || path.length > 1024)) {
    throw new Error('Use at most 100 exact JSON pointers, one per line (example: /meta/requestId).')
  }
  return new Set(paths)
}

export function compareJson(beforeText, afterText, ignoreText = '') {
  const before = parseJson(beforeText)
  const after = parseJson(afterText)
  const ignored = parseIgnoreRules(ignoreText)
  const changes = []
  function walk(left, right, path, leftExists = true, rightExists = true) {
    if (ignored.has(path)) return
    const add = (type) => changes.push({
      path, type,
      before: leftExists ? stringify(left) : '(missing)',
      after: rightExists ? stringify(right) : '(missing)',
      potentialBreaking: type === 'removed' || type === 'type changed',
    })
    if (!leftExists) return add('added')
    if (!rightExists) return add('removed')
    if (kind(left) !== kind(right)) return add('type changed')
    if (kind(left) === 'number') {
      if (canonicalNumber(left) !== canonicalNumber(right)) add('changed')
    } else if (kind(left) === 'object' || kind(left) === 'array') {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        walk(left[key], right[key], `${path}/${pointerPart(key)}`,
          Object.hasOwn(left, key), Object.hasOwn(right, key))
      }
    } else if (left !== right) add('changed')
  }
  walk(before, after, '')
  return changes
}

export function changeReport(changes) {
  return jsonText({
    note: 'Removed fields and type changes may break consumers; this is not contract verification.',
    count: changes.length, changes,
  })
}

export function compareBatch(baseline, files, ignores = '') {
  if (!files.length || files.length > 20) throw new Error('Choose 1-20 JSON files.')
  let total = 0
  for (const file of files) {
    total += new TextEncoder().encode(file.text).length
    parseJson(file.text)
  }
  if (total > 2 * 1024 * 1024) throw new Error('Batch input must not exceed 2 MiB.')
  return files.map((file) => ({ name: file.name, changes: compareJson(baseline, file.text, ignores) }))
}

export function redactJson(text, fields) {
  const names = new Set(fields.split(',').map((field) => field.trim().toLowerCase()).filter(Boolean))
  if (!names.size || names.size > 100) throw new Error('Enter 1-100 comma-separated field names.')
  function walk(value) {
    if (kind(value) === 'array') return value.map(walk)
    if (kind(value) !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, names.has(key.toLowerCase()) ? '[REDACTED]' : walk(child)]))
  }
  return jsonText(walk(parseJson(text)))
}

export function decodeJwt(text, now = Date.now()) {
  checkInput(text)
  const parts = text.trim().split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] ||
    parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) {
    throw new Error('Enter a three-part base64url JWT. Encrypted tokens are not supported.')
  }
  function decode(part) {
    try {
      const bytes = Uint8Array.from(atob(part.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
      return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (error) {
      throw new Error(`Invalid JWT JSON segment: ${error.message}`)
    }
  }
  const header = decode(parts[0])
  const payload = decode(parts[1])
  if (kind(header) !== 'object' || kind(payload) !== 'object') {
    throw new Error('JWT header and payload must be JSON objects.')
  }
  let expiry = 'No exp claim.'
  if (Object.hasOwn(payload, 'exp')) {
    const seconds = kind(payload.exp) === 'number' ? Number(payload.exp.value) : NaN
    expiry = !Number.isFinite(seconds) || Math.abs(seconds) > 8640000000000
      ? 'Invalid or out-of-range exp claim.'
      : `${new Date(seconds * 1000).toISOString()} (${seconds * 1000 <= now ? 'expired' : 'not expired'})`
  }
  return jsonText({
    warning: 'Decoded only. Signature NOT verified; expiry does not prove authenticity. Tokens are not saved automatically.',
    expiry, header, payload,
  })
}
