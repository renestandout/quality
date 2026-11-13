#!/usr/bin/env node
/**
 * Versions-Commit von quality, nur auf grünem main.
 *
 * Aufruf aus dem Repo-Wurzelverzeichnis: `node scripts/release.mjs 0.2.31`.
 * Die Logik und ihre Tests stehen in lib/release.mjs.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRelease } from '../lib/release.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.exitCode = await runRelease({ root, version: process.argv[2] ?? '' })
