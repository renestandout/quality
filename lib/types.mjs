/**
 * Gemeinsame Typen für die Typprüfung mit tsc (checkJs).
 *
 * Das Modul enthält keinen Laufzeitcode. Die Typen beschreiben die
 * Datenformen, die zwischen Runner, Konfiguration und Stack-Adaptern
 * wandern. Die Module binden sie mit `@import` im JSDoc ein.
 */

/** @typedef {'standard' | 'strict'} Level */

/** @typedef {'php' | 'js' | 'py'} Kind */

/** @typedef {'fmt' | 'lint' | 'types' | 'test' | 'build'} Verb */

/**
 * Eine Komponente aus quality.yml, nach der Prüfung durch validateConfig.
 *
 * @typedef {object} Component
 * @property {string} path
 * @property {string} stack
 * @property {string | null} php
 * @property {number} phpstanLevel
 * @property {string | null} testCommand
 */

/**
 * Eine Komponente, ergänzt um die Art ihres Stacks. So reicht der Runner sie
 * an die Stack-Adapter weiter.
 *
 * @typedef {Component & { kind: Kind }} StackComponent
 */

/**
 * @typedef {object} Profile
 * @property {boolean} blocking
 * @property {boolean} requireAiReview
 * @property {string} tsStrict
 */

/**
 * Die geprüfte Konfiguration, wie validateConfig sie zurückgibt.
 *
 * @typedef {object} ValidConfig
 * @property {number} version
 * @property {Level} level
 * @property {boolean} baseline
 * @property {Component[]} components
 * @property {Record<string, string>} configs
 * @property {string[]} tamperIgnore
 * @property {Profile} profile
 */

/**
 * Die geladene Konfiguration: zusätzlich Datei und Repo-Wurzel.
 *
 * @typedef {ValidConfig & { file: string, root: string }} Config
 */

/**
 * Ein Prüfschritt. Entweder ein Aufruf (`cmd`) oder ein übersprungener
 * Schritt mit Grund (`skip`).
 *
 * Optionale Felder lassen `undefined` ausdrücklich zu. Die Adapter setzen
 * etwa `note: bedingung ? undefined : '…'`.
 *
 * @typedef {object} Step
 * @property {string} name
 * @property {string | undefined} [cmd]
 * @property {string[] | undefined} [args]
 * @property {string | undefined} [cwd]
 * @property {Record<string, string> | undefined} [env]
 * @property {string | undefined} [skip]
 * @property {string | undefined} [note]
 * @property {boolean | undefined} [soft]
 */

/**
 * Das Ergebnis eines Prüfschritts.
 *
 * @typedef {object} StepResult
 * @property {string} name
 * @property {number} code
 * @property {string} output
 * @property {string | undefined} [note]
 * @property {boolean | undefined} [soft]
 * @property {boolean | undefined} [skipped]
 * @property {string | undefined} [reason]
 * @property {boolean | undefined} [spawnError]
 */

/**
 * Was ein Stack-Adapter über den Lauf erfährt.
 *
 * @typedef {object} StackContext
 * @property {string} dir
 * @property {string} root
 * @property {StackComponent} component
 * @property {Config} config
 * @property {string[] | null} files
 * @property {boolean} check
 * @property {boolean} full
 */

/** @typedef {(ctx: StackContext) => Step | null | undefined} StepFactory */

/**
 * Ein Stack-Adapter aus stacks/.
 *
 * @typedef {object} Stack
 * @property {string} name
 * @property {Kind} kind
 * @property {StepFactory | undefined} [fmt]
 * @property {StepFactory | undefined} [lint]
 * @property {StepFactory | undefined} [types]
 * @property {StepFactory | undefined} [test]
 * @property {StepFactory | undefined} [build]
 */

export {}
