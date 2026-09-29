/** Copy the built artifact to a new versioned snapshot; never activate it. */
import { readFile, mkdir, cp, symlink, realpath, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const source = fileURLToPath(new URL('..', import.meta.url))
const install = resolve(process.env.DSH_INSTALL ?? '/Users/maz/.local/share/deepseek-harness/0.2.0-rc.1-native-20260928')
const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
const target = join(install, 'plugins', `${pkg.name}-${pkg.version}`)
await mkdir(target) // Refuse to overwrite an existing deployed snapshot.
for (const file of ['lib', 'package.json', 'README.md', 'cordis.patch.yml']) await cp(join(source, file), join(target, file), { recursive: true, errorOnExist: true, force: false })
await mkdir(join(target, 'node_modules/@deepseek-ai'), { recursive: true })
const deps = { cordis: 'vendor/cordis', 'dsh-agent': 'packages/core/agent', 'dsh-llm': 'packages/llm/llm',
  'dsh-tools': 'packages/core/tools', 'dsh-session': 'packages/core/session', 'dsh-commands': 'packages/interaction/commands' }
for (const [name, path] of Object.entries(deps)) {
  const dependency = join(install, path)
  const actual = JSON.parse(await readFile(join(dependency, 'package.json'), 'utf8'))
  if (actual.version !== pkg.peerDependencies[`@deepseek-ai/${name}`]) throw new Error(`Peer mismatch: ${name}`)
  await symlink(dependency, join(target, 'node_modules/@deepseek-ai', name))
}
await symlink(await realpath(join(install, 'plugins/dsh-generation-recovery/node_modules/zod')), join(target, 'node_modules/zod'))
const hashes = {}
for (const file of ['package.json', 'README.md', 'cordis.patch.yml', ...(await readdir(join(target, 'lib'))).map(f => 'lib/' + f)])
  hashes[file] = createHash('sha256').update(await readFile(join(target, file))).digest('hex')
await writeFile(join(target, 'SHA256.json'), JSON.stringify({ createdAt: new Date().toISOString(), source, hashes }, null, 2) + '\n')
console.log(JSON.stringify({ target, hashes }))
