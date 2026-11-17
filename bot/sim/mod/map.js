// Mojang name -> obfuscated + Fabric intermediary name, to write mixins for sim/mod (sources use intermediary names).
//   node sim/mod/map.js net.minecraft.server.level.ServerPlayer [doTick]
// Needs in mcserver-sim/fabric-cache/: server_mappings.txt (Mojang server mappings for 1.21.11, from the version
// json downloads.server_mappings) and mappings/mappings.tiny (from libraries/net/fabricmc/intermediary/*.jar).
// Overridden methods are listed under the class that declares them first (e.g. ServerPlayer.tick -> Entity.tick).
const fs = require('fs')
const path = require('path')
process.chdir(path.join(__dirname, '..', '..', '..', 'mcserver-sim', 'fabric-cache'))
const [cls, meth] = process.argv.slice(2)
const moj = fs.readFileSync('server_mappings.txt', 'utf8').split('\n')
const classes = {}   // mojang -> obf
let cur = null, methods = []
for (const l of moj) {
  if (l.startsWith('#')) continue
  const c = l.match(/^(\S+) -> (\S+):/)
  if (c) { classes[c[1]] = c[2]; cur = c[1]; continue }
  const m = l.match(/^\s+(?:\d+:\d+:)?(\S+) (\w+)\(([^)]*)\) -> (\S+)/)
  if (m && cur === cls && (!meth || m[2] === meth)) methods.push({ ret: m[1], name: m[2], args: m[3], obf: m[4] })
}
const obf = classes[cls]
const tiny = fs.readFileSync('mappings/mappings.tiny', 'utf8').split('\n')
const inter = {}
for (const l of tiny) {
  const p = l.split('\t')
  if (p[0] === 'CLASS') inter[p[1]] = p[2]
}
console.log(cls, obf, inter[obf])
// method intermediary: match by obf class + obf name + descriptor
const prim = { void: 'V', boolean: 'Z', int: 'I', long: 'J', float: 'F', double: 'D', byte: 'B', short: 'S', char: 'C' }
const desc = t => { let a = ''; while (t.endsWith('[]')) { a += '['; t = t.slice(0, -2) } return a + (prim[t] || 'L' + (classes[t] || t).replace(/\./g, '/') + ';') }
for (const m of methods) {
  const d = '(' + (m.args ? m.args.split(',').map(desc).join('') : '') + ')' + desc(m.ret)
  const hit = tiny.find(l => { const p = l.split('\t'); return p[0] === 'METHOD' && p[1] === obf && p[2] === d && p[3] === m.obf })
  console.log(' ', m.ret, m.name + '(' + m.args + ')', m.obf, d, hit ? hit.split('\t')[4] : '?')
}
