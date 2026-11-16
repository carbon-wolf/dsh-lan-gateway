// Create the GitHub release for the current version and upload the single-file exe.
//
//   node scripts/publish-release.mjs [--tag v0.1.0] [--asset dist/dsh-gateway.exe]
//
// Auth: reuses whatever `git credential fill` returns for github.com (the same
// credential a `git push` uses). The token is never printed.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const tag = argOf('--tag', `v${pkg.version}`)
const assetPath = join(ROOT, argOf('--asset', join('dist', 'dsh-gateway.exe')))

if (!existsSync(assetPath)) {
  console.error(`缺少产物：${assetPath}\n先运行 node scripts/build-exe.mjs`)
  process.exit(1)
}

/** Read the git credential for github.com without echoing it. */
function githubCredentials() {
  const raw = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const fields = {}
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1)
  }
  if (fields.password === undefined) throw new Error('git credential 没有返回口令')
  return { username: fields.username ?? '', token: fields.password }
}

const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim()
const match = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/.exec(remote)
if (match === null) {
  console.error(`无法从 origin 解析仓库：${remote}`)
  process.exit(1)
}
const [, owner, repo] = match

const { token } = githubCredentials()
const api = `https://api.github.com/repos/${owner}/${repo}`
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-lan-gateway',
  'x-github-api-version': '2022-11-28',
}

const notes = readFileSync(join(ROOT, 'RELEASE_NOTES.md'), 'utf8')

console.log(`创建 release ${tag} -> ${owner}/${repo}`)
const created = await fetch(`${api}/releases`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    tag_name: tag,
    name: `DSH 局域网网关 ${tag}`,
    body: notes,
    draft: false,
    prerelease: false,
  }),
})

if (!created.ok) {
  const text = await created.text()
  console.error(`创建失败 HTTP ${created.status}: ${text.slice(0, 400)}`)
  console.error('如果 release 已存在，把同名 tag 的 release 删掉再试。')
  process.exit(1)
}

const release = await created.json()
console.log(`release: ${release.html_url}`)

const size = statSync(assetPath).size
console.log(`上传 ${assetPath} (${(size / 1024 / 1024).toFixed(1)} MB)`)
const uploadUrl = String(release.upload_url).replace('{?name,label}', `?name=${encodeURIComponent('dsh-gateway.exe')}`)
const uploaded = await fetch(uploadUrl, {
  method: 'POST',
  headers: {
    ...headers,
    'content-type': 'application/octet-stream',
    'content-length': String(size),
  },
  body: readFileSync(assetPath),
  duplex: 'half',
})

if (!uploaded.ok) {
  console.error(`上传失败 HTTP ${uploaded.status}: ${(await uploaded.text()).slice(0, 300)}`)
  process.exit(1)
}

const asset = await uploaded.json()
console.log(`asset: ${asset.browser_download_url}`)
