import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const dir = join(root, '.wrangler')
await mkdir(dir, { recursive: true })
const configPath = join(dir, 'auth-local.json')
const config = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'))
config.main = join(root, 'worker/local.ts')
delete config.routes
delete config.send_email
// Keep the existing local database identity across the remote database move.
// This UUID is only a local storage key; remote access is explicitly disabled.
config.d1_databases = config.d1_databases.map(db => ({ ...db, database_id: '2ebddf0d-bb3f-4fee-8448-64306706035a', remote: false, migrations_dir: join(root, db.migrations_dir) }))
await writeFile(configPath, JSON.stringify(config, null, 2))
// Preserve real Google client credentials privately, but never copy production
// session secrets/origins into local operation. Wrangler reads this adjacent file.
const source = await readFile(join(root, '.dev.vars'), 'utf8').catch(() => '')
const google = source.split('\n').filter(line => /^GOOGLE_CLIENT_(ID|SECRET)=/.test(line)).join('\n')
const secretPath = join(dir, 'auth-local-secret')
let secret = await readFile(secretPath, 'utf8').catch(() => '')
if (!secret) {
  secret = randomBytes(32).toString('hex')
  await writeFile(secretPath, secret, { mode: 0o600 })
}
await writeFile(join(dir, '.dev.vars'), `${google}\nBETTER_AUTH_SECRET=${secret}\nBETTER_AUTH_URL=http://localhost:5173\n`, { mode: 0o600 })
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js')
function run(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args, '--config', configPath], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run(['d1', 'migrations', 'apply', config.d1_databases[0].database_name, '--local'])
run(['d1', 'execute', config.d1_databases[0].database_name, '--local', '--command', 'CREATE TABLE IF NOT EXISTS authLocalMail(id TEXT PRIMARY KEY,recipient TEXT,subject TEXT,text TEXT,createdAt INTEGER)'])
if (process.argv.includes('--build-test')) {
  // Test only fresh bundles; do not leave artifacts from a previous build.
  await rm(join(dir, 'auth-test-dist'), { recursive: true, force: true })
  await rm(join(dir, 'auth-dist'), { recursive: true, force: true })
  run(['deploy', '--dry-run', '--outdir', join(dir, 'auth-test-dist')])
  process.exit(0)
}
if (process.argv.includes('--prepare')) process.exit(0)
console.log('Local auth database ready. Email inbox: http://localhost:5173/__dev/mail')
const child = spawn(process.execPath, [wrangler, 'dev', '--config', configPath, '--port', '8787'], { cwd: root, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { process.exitCode = code ?? 1 })
