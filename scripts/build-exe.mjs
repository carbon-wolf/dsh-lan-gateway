// Build a single-file Windows executable for the gateway (Node SEA).
//
//   node scripts/build-exe.mjs
//
// Output: dist/dsh-gateway.exe — double-click to run. It carries the proxy code
// plus the injected CSS/JS, and reads/writes config.json, auth.json, sessions.json
// and logs/ next to itself, so an empty folder is a valid install.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BUILD = join(ROOT, 'build')
const DIST = join(ROOT, 'dist')
const EXE = join(DIST, 'dsh-gateway.exe')
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

mkdirSync(BUILD, { recursive: true })
mkdirSync(DIST, { recursive: true })

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

console.log('1/5 bundling gateway/server.mjs -> build/bundle.cjs')
await build({
  entryPoints: [join(ROOT, 'gateway', 'server.mjs')],
  outfile: join(BUILD, 'bundle.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['node:*'],
  legalComments: 'none',
  logLevel: 'warning',
  define: {
    // SEA runs as CommonJS; the gateway resolves its install directory from
    // process.execPath under SEA, so this fallback is never used there.
    'import.meta.url': 'undefined',
  },
})

console.log('2/5 writing build/sea-config.json')
const seaConfig = {
  main: join(BUILD, 'bundle.cjs').replaceAll('\\', '/'),
  output: join(BUILD, 'sea-prep.blob').replaceAll('\\', '/'),
  disableExperimentalSEAWarning: true,
  assets: {
    'mobile.css': join(ROOT, 'inject', 'mobile.css').replaceAll('\\', '/'),
    'mobile.js': join(ROOT, 'inject', 'mobile.js').replaceAll('\\', '/'),
  },
}
writeFileSync(join(BUILD, 'sea-config.json'), `${JSON.stringify(seaConfig, null, 2)}\n`)

console.log('3/5 generating SEA blob')
execFileSync(process.execPath, ['--experimental-sea-config', join(BUILD, 'sea-config.json')], { stdio: 'inherit' })

console.log('4/5 copying the Node runtime and injecting the blob')
copyFileSync(process.execPath, EXE)
const postjectCli = join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js')
execFileSync(process.execPath, [
  postjectCli,
  EXE,
  'NODE_SEA_BLOB',
  join(BUILD, 'sea-prep.blob'),
  '--sentinel-fuse',
  FUSE,
], { stdio: 'inherit' })

const size = statSync(EXE).size
console.log(`5/5 done: ${EXE} (${(size / 1024 / 1024).toFixed(1)} MB, version ${version})`)
console.log('Double-click it, or run: dsh-gateway.exe --version')
