// MineSim player-freeze Fabric mod: build without Gradle/Loom. The sources use Fabric intermediary names and are
// compiled directly against the server jar remapped by Fabric loader (.fabric/remappedJars/.../server-intermediary.jar),
// so no remapping step is needed. javac/jar run as modules of the java runtime (jdk.compiler, jdk.jartool).
//   ensure(instanceDir, java): Fabric launcher in the instance, server remapped once (--initSettings), mod built if
//   stale, copied to <instance>/mods/. Called by sim/instance.js start().
//   node sim/mod/build.js [n]  (default instance 0)
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const MC = '1.21.11', LOADER = '0.20.1', INSTALLER = '1.1.2'
const LAUNCHER = 'fabric-server-launch.jar'
const LAUNCHER_URL = `https://meta.fabricmc.net/v2/versions/loader/${MC}/${LOADER}/${INSTALLER}/server/jar`
const HERE = __dirname
const OUT = path.join(HERE, 'build')
const JAR = path.join(OUT, 'minesim-freeze.jar')
const CACHE = path.join(HERE, '..', '..', '..', 'mcserver-sim', 'fabric-cache')

function files(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]) }
function run(java, args, cwd) {
  const r = spawnSync(java, args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`${args.slice(0, 2).join(' ')} failed (${r.status}):\n${r.stdout}${r.stderr}`)
  return r.stdout
}

async function launcher() {
  const f = path.join(CACHE, LAUNCHER)
  if (fs.existsSync(f)) return f
  fs.mkdirSync(CACHE, { recursive: true })
  const res = await fetch(LAUNCHER_URL)
  if (!res.ok) throw new Error(`download ${LAUNCHER_URL}: ${res.status}`)
  fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()))
  return f
}

function remapped(dir) {
  const f = path.join(dir, '.fabric', 'remappedJars', `minecraft-${MC}-${LOADER}`, 'server-intermediary.jar')
  return fs.existsSync(f) ? f : null
}

function build(dir, java) {
  const srcs = files(path.join(HERE, 'src')).filter(f => f.endsWith('.java'))
  const res = files(path.join(HERE, 'resources'))
  const newest = Math.max(...[...srcs, ...res, __filename].map(f => fs.statSync(f).mtimeMs))
  if (fs.existsSync(JAR) && fs.statSync(JAR).mtimeMs > newest) return JAR
  const lib = path.join(dir, 'libraries')
  const cp = [remapped(dir), ...files(lib).filter(f => /sponge-mixin|fabric-loader|[\\/]asm[\\/]|slf4j/.test(f) && f.endsWith('.jar'))]
  const classes = path.join(OUT, 'classes')
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(classes, { recursive: true })
  run(java, ['-m', 'jdk.compiler/com.sun.tools.javac.Main', '--release', '21', '-proc:none', '-nowarn',
    '-cp', cp.join(path.delimiter), '-d', classes, ...srcs])
  for (const f of res) fs.copyFileSync(f, path.join(classes, path.basename(f)))
  run(java, ['-m', 'jdk.jartool/sun.tools.jar.Main', 'cf', JAR, '-C', classes, '.'])
  return JAR
}

// returns the jar to launch (Fabric launcher, relative to dir)
async function ensure(dir, java) {
  fs.copyFileSync(await launcher(), path.join(dir, LAUNCHER))
  // first Fabric start: downloads loader libraries, remaps the server; --initSettings exits right after
  if (!remapped(dir)) run(java, ['-jar', LAUNCHER, '--initSettings', 'nogui'], dir)
  if (!remapped(dir)) throw new Error(`Fabric did not produce server-intermediary.jar in ${dir}`)
  const jar = build(dir, java)
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true })
  fs.copyFileSync(jar, path.join(dir, 'mods', path.basename(jar)))
  return LAUNCHER
}

module.exports = { ensure, build, JAR }

if (require.main === module) {
  const inst = require('../instance')
  const s = inst.create(+(process.argv[2] || 0))
  ensure(s.dir, inst.JAVA).then(j => console.log(`built ${JAR}, installed in ${s.dir}/mods (launch ${j})`), e => { console.error(e.message); process.exit(1) })
}
