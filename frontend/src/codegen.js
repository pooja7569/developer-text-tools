import { checkInput, kind, parseJson } from './developerTools.js'

const PY_RESERVED = new Set(('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case dict json schema schema_json copy validate construct parse_obj parse_raw parse_file from_orm update_forward_refs __root__').split(' '))

export function generateModels(text, { language = 'typescript', root = 'ApiResponse', extra = 'ignore' } = {}) {
  checkInput(text)
  if (!['typescript', 'pydantic'].includes(language) || !['ignore', 'forbid'].includes(extra)) {
    throw new Error('Unsupported generation preset.')
  }
  if (!/^[A-Z][A-Za-z0-9]{0,49}$/.test(root) || PY_RESERVED.has(root) ||
    ['BaseModel', 'RootModel', 'ConfigDict', 'Decimal', 'Any', 'Field'].includes(root)) {
    throw new Error('Use a root name starting with an uppercase letter, followed by up to 49 letters or digits.')
  }
  const examples = text.split(/^\s*---\s*$/m).map((example) => parseJson(example))
  if (examples.length > 20) throw new Error('Use at most 20 JSON examples, separated by a line containing ---.')
  const blocks = []
  const warnings = new Set(['Types are inferred from examples, not a verified API contract. Review before use.'])
  let serial = 0
  const py = language === 'pydantic'
  function infer(values, name, isRoot = false) {
    const groups = new Map()
    for (const value of values) {
      const type = kind(value)
      if (!groups.has(type)) groups.set(type, [])
      groups.get(type).push(value)
    }
    const types = []
    for (const [type, group] of groups) {
      if (type === 'object') {
        const className = isRoot && groups.size === 1 ? root : `${root}Model${++serial}`
        const keys = new Set(group.flatMap((object) => Object.keys(object)))
        const used = new Set()
        const fields = []
        for (const key of keys) {
          const present = group.filter((object) => Object.hasOwn(object, key))
          const optional = present.length !== group.length
          let fieldType = infer(present.map((object) => object[key]), name + key)
          if (py) {
            let identifier = key.replace(/[^A-Za-z0-9_]/g, '_')
            if (!/^[A-Za-z]/.test(identifier) || PY_RESERVED.has(identifier) || identifier.startsWith('model_')) {
              identifier = 'field_' + identifier.replace(/^_+/, '')
            }
            if (!identifier) identifier = 'field_value'
            const base = identifier
            let suffix = 1
            while (used.has(identifier)) identifier = `${base}_${suffix++}`
            used.add(identifier)
            if (optional && !fieldType.split(' | ').includes('None')) fieldType += ' | None'
            const alias = identifier !== key ? `, alias=${JSON.stringify(key)}` : ''
            fields.push(`    ${identifier}: ${fieldType} = Field(${optional ? 'default=None' : '...'}${alias})`)
          } else {
            fields.push(`  ${JSON.stringify(key)}${optional ? '?' : ''}: ${fieldType};`)
          }
        }
        blocks.push(py
          ? `class ${className}(BaseModel):\n    model_config = ConfigDict(extra="${extra}", populate_by_name=True)\n${fields.join('\n') || '    pass'}`
          : `export interface ${className} {\n${fields.join('\n')}\n}`)
        types.push(className)
      } else if (type === 'array') {
        const items = group.flat()
        let child
        if (!items.length) {
          child = py ? 'Any' : 'unknown'
          warnings.add('Empty arrays have an unknown item type.')
        } else child = infer(items, name + 'Item')
        types.push(py ? `list[${child}]` : `Array<${child}>`)
      } else if (type === 'number') {
        if (py) {
          types.push(group.every((value) => /^-?\d+$/.test(value.value)) ? 'int' : 'Decimal')
          warnings.add('Use Decimal-aware JSON parsing when Python must preserve decimal precision.')
        } else {
          types.push('number')
          warnings.add('TypeScript number uses floating-point arithmetic; large integers and precise decimals may need a string-based API contract.')
        }
      } else {
        types.push(({ string: py ? 'str' : 'string', boolean: py ? 'bool' : 'boolean', null: py ? 'None' : 'null' })[type])
      }
    }
    return [...new Set(types)].join(' | ')
  }
  const type = infer(examples, root, true)
  if (type !== root) blocks.push(py
    ? `class ${root}(RootModel[${type}]):\n    pass`
    : `export type ${root} = ${type};`)
  const imports = py
    ? 'from __future__ import annotations\n\nfrom decimal import Decimal\nfrom typing import Any\nfrom pydantic import BaseModel, ConfigDict, Field, RootModel\n\n'
    : ''
  return { code: imports + blocks.join('\n\n') + '\n', warnings: [...warnings] }
}
