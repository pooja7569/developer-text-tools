import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compareBatch, compareJson, decodeJwt, formatJsonSafe, inspectValue, jsonToYaml,
  parseJson, redactJson, yamlToJson,
} from './developerTools.js'
import { generateModels } from './codegen.js'

test('preserves exact JSON integers and decimals and reports duplicate keys with positions', () => {
  const json = '{"n":9007199254740993,"d":0.1234567890123456789}'
  assert.match(formatJsonSafe(json), /9007199254740993/)
  assert.match(formatJsonSafe(json), /0.1234567890123456789/)
  assert.throws(() => parseJson('{\n"a":1,"a":2}'), /Duplicate key.*line 2, column/)
  assert.throws(() => parseJson(' '.repeat(256 * 1024) + '1'), /256 KiB/)
  assert.throws(() => parseJson('['.repeat(65) + '0' + ']'.repeat(65)), /64 nesting/)
  assert.throws(() => parseJson('[' + '0,'.repeat(10000) + '0]'), /10,000 values/)
  assert.doesNotThrow(() => parseJson(JSON.stringify('['.repeat(100))))
})

test('JSON and YAML round-trip nested containers, quoted keys, and precise numbers', () => {
  const json = '{"yes":true,"n":null,"a":[{"str":"a\\nb"},[],{}],"x":9007199254740993,"y":0.1234567890123456789,"__proto__":{"safe":true}}'
  const yaml = jsonToYaml(json)
  assert.match(yaml, /9007199254740993/)
  assert.deepEqual(compareJson(json, yamlToJson(yaml)), [])
  assert.match(yamlToJson('amount: +.1234567890123456789\nhex: 0xFF\n'), /0.1234567890123456789/)
  assert.match(yamlToJson('amount: 1.e+3'), /1.0e\+3/)
})

test('rejects ambiguous and unsafe YAML rather than silently converting it', () => {
  for (const text of ['a: 1\na: 2', 'a: &x [1]\nb: *x', 'a: !!str 12', 'a: .nan', 'true: value', 'a: !custom value', 'a: 1\n---\nb: 2']) {
    assert.throws(() => yamlToJson(text), Error, text)
  }
  assert.throws(() => yamlToJson('a: ' + '['.repeat(70) + '0' + ']'.repeat(70)), /complex/)
})

test('comparison distinguishes null, missing, arrays, type changes, and exact numeric values', () => {
  assert.deepEqual(compareJson('{"a":1.0,"b":10e-1,"z":-0}', '{"z":0,"b":1,"a":1e0}'), [])
  assert.equal(compareJson('9007199254740992', '9007199254740993')[0].type, 'changed')
  const changes = compareJson('{"a":null,"b":1,"arr":[1,2]}', '{"b":"1","arr":[2,1]}')
  assert.equal(changes.find((change) => change.path === '/a').before, 'null')
  assert.equal(changes.find((change) => change.path === '/a').after, '(missing)')
  assert.equal(changes.filter((change) => change.potentialBreaking).length, 2)
  assert.equal(changes.length, 4)
})

test('ignore pointers are exact and safely escaped, including subtree rules', () => {
  const before = '{"a/b":{"~value":1},"meta":{"id":1},"metadata":0}'
  const after = '{"a/b":{"~value":2},"meta":{"id":2},"metadata":1}'
  const changes = compareJson(before, after, '/a~1b/~0value\n/meta')
  assert.deepEqual(changes.map((change) => change.path), ['/metadata'])
  assert.throws(() => compareJson('1', '2', 'meta.id'), /JSON pointers/)
  assert.throws(() => compareJson('1', '2', '/bad~2'), /JSON pointers/)
})

test('batch comparisons fail the entire operation on invalid input and enforce file limits', () => {
  assert.equal(compareBatch('{"x":1}', [{ name: 'a.json', text: '{"x":2}' }])[0].changes.length, 1)
  assert.throws(() => compareBatch('{}', [{ name: 'bad.json', text: '{broken' }]), SyntaxError)
  assert.throws(() => compareBatch('{}', Array(21).fill({ name: 'x', text: '{}' })), /1-20/)
  const exactInput = JSON.stringify('x'.repeat(256 * 1024 - 2))
  const files = Array(8).fill({ name: 'limit.json', text: exactInput })
  assert.equal(compareBatch(exactInput, files).length, 8)
  assert.throws(() => compareBatch(exactInput, [...files, files[0]]), /2 MiB/)
})

test('redaction is case-insensitive, recursive, and leaves original data untouched', () => {
  const original = '{"Token":"secret","items":[{"password":"p","other":"kept"}]}'
  const redacted = redactJson(original, 'token, PASSWORD')
  assert.doesNotMatch(redacted, /secret/)
  assert.match(redacted, /kept/)
  assert.match(original, /secret/)
  assert.throws(() => redactJson('{}', ' , '), /field names/)
  assert.equal(inspectValue(parseJson('{"a/b":{"~key":1}}')).at(-1).path, '/a~1b/~0key')
})

test('JWT decodes UTF-8 locally, exposes expiry, and never claims signature verification', () => {
  const encode = (object) => Buffer.from(JSON.stringify(object)).toString('base64url')
  const token = `${encode({ alg: 'HS256' })}.${encode({ sub: 'caf\u00e9', exp: 100 })}.abc`
  const result = decodeJwt(token, 101000)
  assert.match(result, /Signature NOT verified/)
  assert.match(result, /expired/)
  assert.match(result, /caf\u00e9/)
  assert.match(decodeJwt(`${encode({})}.${encode({ exp: '100' })}.`), /Invalid or out-of-range/)
  assert.throws(() => decodeJwt('invalid.token'), /three-part/)
  assert.throws(() => decodeJwt(`${encode([])}.${encode({})}.`), /JSON objects/)
  assert.throws(() => decodeJwt('_w.e30.'), /utf-8/i)
})

test('TypeScript inference merges examples, supports arrays/unions, and warns about precision', () => {
  const result = generateModels('{"id":9007199254740993,"items":[1,"s"],"present":true}\n---\n{"id":1,"items":[]}')
  assert.match(result.code, /"present"\?: boolean/)
  assert.match(result.code, /Array<number \| string>/)
  assert.ok(result.warnings.some((warning) => warning.includes('floating-point')))
  assert.match(generateModels('[]').code, /Array<unknown>/)
  assert.match(generateModels('null\n---\n{"a":1}').code, /export type ApiResponse = null \| ApiResponseModel1/)
  assert.throws(() => generateModels(Array(21).fill('{}').join('\n---\n')), /20 JSON examples/)
})

test('Pydantic generation handles aliases, protected names, optional fields and primitive roots', () => {
  const { code } = generateModels('{"class":1,"model_dump":"a","a-b":null,"a_b":1,"schema":true}\n---\n{"class":2}', { language: 'pydantic', extra: 'forbid' })
  assert.match(code, /field_class: int = Field\(\.\.\., alias="class"\)/)
  assert.match(code, /field_model_dump: str \| None/)
  assert.match(code, /a_b_1: int \| None/)
  assert.match(code, /field_schema: bool \| None/)
  assert.match(code, /extra="forbid"/)
  assert.match(generateModels('[1,2.1]', { language: 'pydantic' }).code, /RootModel\[list\[Decimal\]\]/)
  assert.throws(() => generateModels('{}', { root: 'Bad;code' }), /root name/)
  assert.throws(() => generateModels('{}', { language: 'pydantic', root: 'None' }), /root name/)
})
