import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseYaml } from './yaml.mjs'

export const LEVELS = ['standard', 'strict']
export const KNOWN_STACKS = ['laravel', 'php', 'react-ts', 'next-ts', 'node-ts']

/** Standardwerte je Profil. Das PHPStan-Level steht bewusst NICHT hier — es
 *  gehört zur Komponente, weil es bei Bestandscode schrittweise steigt. */
export const PROFILE = {
  standard: { blocking: true, requireAiReview: false, tsStrict: 'base' },
  strict: { blocking: true, requireAiReview: true, tsStrict: 'strict' },
}

class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Sucht quality.yml ab startDir aufwärts bis zur Repo-Wurzel. */
export function findConfigFile(startDir = process.cwd()) {
  let dir = resolve(startDir)
  for (;;) {
    for (const name of ['quality.yml', 'quality.yaml']) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function assertType(value, type, label) {
  if (typeof value !== type) {
    throw new ConfigError(`${label} muss ${type === 'boolean' ? 'true oder false' : `vom Typ ${type}`} sein, ist aber "${value}".`)
  }
}

export function validateConfig(raw, file) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${file}: erwartet wird eine Map mit den Schlüsseln level, baseline und components.`)
  }

  const version = raw.version ?? 1
  if (version !== 1) {
    throw new ConfigError(`${file}: version ${version} ist unbekannt — dieses quality kennt nur version 1.`)
  }

  const level = raw.level ?? 'standard'
  if (!LEVELS.includes(level)) {
    throw new ConfigError(`${file}: level "${level}" ist unbekannt, erlaubt sind ${LEVELS.join(' oder ')}.`)
  }

  const baseline = raw.baseline ?? false
  assertType(baseline, 'boolean', `${file}: baseline`)

  if (!Array.isArray(raw.components) || raw.components.length === 0) {
    throw new ConfigError(`${file}: components fehlt oder ist leer — mindestens eine Komponente mit path und stack ist nötig.`)
  }

  const components = raw.components.map((component, index) => {
    const label = `${file}: components[${index}]`
    if (component === null || typeof component !== 'object' || Array.isArray(component)) {
      throw new ConfigError(`${label} muss eine Map mit path und stack sein.`)
    }
    const { path, stack } = component
    if (typeof path !== 'string' || path === '') {
      throw new ConfigError(`${label}.path fehlt.`)
    }
    if (isAbsolute(path)) {
      throw new ConfigError(`${label}.path muss relativ zur Repo-Wurzel sein, ist aber absolut ("${path}").`)
    }
    if (typeof stack !== 'string' || stack === '') {
      throw new ConfigError(`${label}.stack fehlt.`)
    }
    if (!KNOWN_STACKS.includes(stack)) {
      throw new ConfigError(`${label}.stack "${stack}" ist unbekannt, bekannt sind: ${KNOWN_STACKS.join(', ')}.`)
    }
    if (component.phpstan_level !== undefined) {
      const lvl = component.phpstan_level
      if (!Number.isInteger(lvl) || lvl < 0 || lvl > 10) {
        throw new ConfigError(`${label}.phpstan_level muss eine ganze Zahl von 0 bis 10 sein, ist aber "${lvl}".`)
      }
    }
    if (component.php !== undefined && typeof component.php !== 'string') {
      throw new ConfigError(`${label}.php muss als Zeichenkette angegeben werden, z.B. php: "8.3".`)
    }
    return {
      path,
      stack,
      php: component.php ?? null,
      phpstanLevel: component.phpstan_level ?? (level === 'strict' ? 8 : 5),
      testCommand: component.test_command ?? null,
    }
  })

  return { version, level, baseline, components, profile: PROFILE[level] }
}

export function loadConfig(startDir = process.cwd()) {
  const file = findConfigFile(startDir)
  if (!file) {
    throw new ConfigError(
      'Keine quality.yml gefunden. Lege sie in der Repo-Wurzel an — "quality init" schlägt einen passenden Inhalt vor.'
    )
  }
  const config = validateConfig(parseYaml(readFileSync(file, 'utf8')), file)
  return { ...config, file, root: dirname(file) }
}

export { ConfigError }
