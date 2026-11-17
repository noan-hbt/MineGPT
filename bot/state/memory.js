// Long-term memory (notes, places, routines) persisted per bot across sessions, plus the session's episode and
// goal stack. Storage only: the model writes it (note:, name_place, save_routine, goal:, plan:), code never does,
// except facts it observed (deaths). Times are kept as epoch ms on disk and exposed session-relative (can be < 0).
'use strict'
const fs = require('fs')
const path = require('path')

const MAX_NOTES = 200

class Memory {
  constructor(file, t0 = Date.now()) {
    this.file = file
    this.t0 = t0
    let d = {}
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    this.notes = d.notes || []       // {key?, text, at}
    this.places = d.places || []     // {name, pos, dimension?, what?, seen_at?}
    this.routines = d.routines || [] // {name, src, runs, ok}
    this.episode = { summary: '', summary_at: null, deaths: [], goals_done: [] }
    this.goals = { stack: [], plan: [] }
  }

  rel(at) { return at == null ? undefined : Math.round(at - this.t0) }
  save() {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify({ notes: this.notes, places: this.places, routines: this.routines }, null, 1))
  }

  note(text, key) {
    if (key) this.notes = this.notes.filter(n => n.key !== key)
    this.notes.push({ ...(key ? { key } : {}), text, at: Date.now() })
    if (this.notes.length > MAX_NOTES) this.notes.shift()
    this.save()
  }
  forget(key) { this.notes = this.notes.filter(n => n.key !== key); this.places = this.places.filter(p => p.name !== key); this.save() }
  namePlace(name, pos, what, dimension = 'overworld') {
    this.places = this.places.filter(p => p.name !== name)
    this.places.push({ name, pos: pos.map(Math.floor), dimension, ...(what ? { what } : {}), seen_at: Date.now() })
    this.save()
  }
  seePlace(name) { const p = this.places.find(p => p.name === name); if (p) p.seen_at = Date.now() }
  saveRoutine(name, src) {
    const old = this.routines.find(r => r.name === name)
    this.routines = this.routines.filter(r => r.name !== name)
    this.routines.push({ name, src, runs: old ? old.runs : 0, ok: old ? old.ok : 0 })
    this.save()
  }

  death(pos, cause) { this.episode.deaths.push({ at: Date.now(), pos: pos.map(Math.floor), cause }) }
  summarize(text) { this.episode.summary = text; this.episode.summary_at = Date.now() }

  // goal: push <text> | replace <text> | done | fail <reason>
  goal(op, text, source = 'self', from) {
    const g = { text, source, ...(from ? { from } : {}), at: Date.now() }
    if (op === 'push') this.goals.stack.unshift(g)
    else if (op === 'replace') { this.goals.stack.shift(); this.goals.stack.unshift(g) }
    else if (op === 'done' || op === 'fail') {
      const top = this.goals.stack.shift()
      if (top) this.episode.goals_done.push({ text: top.text, at: Date.now(), status: op })
    }
  }
  setPlan(steps) { this.goals.plan = steps.map(s => ({ step: s, done: false })) }

  state() {
    const r = x => this.rel(x)
    return {
      memory: {
        notes: this.notes.map(n => ({ ...(n.key ? { key: n.key } : {}), text: n.text, t: r(n.at) })),
        places: this.places.map(p => ({ name: p.name, pos: p.pos, ...(p.dimension ? { dimension: p.dimension } : {}),
          ...(p.what ? { what: p.what } : {}), ...(p.seen_at ? { seen_t: r(p.seen_at) } : {}) })),
        routines: this.routines.map(x => ({ ...x })),
      },
      episode: {
        summary: this.episode.summary, ...(this.episode.summary_at ? { summary_t: r(this.episode.summary_at) } : {}),
        deaths: this.episode.deaths.map(d => ({ t: r(d.at), pos: d.pos, cause: d.cause })),
        goals_done: this.episode.goals_done.map(g => ({ text: g.text, t: r(g.at), status: g.status })),
      },
      goals: {
        stack: this.goals.stack.map(g => ({ text: g.text, source: g.source, ...(g.from ? { from: g.from } : {}), t: r(g.at) })),
        plan: this.goals.plan.map(p => ({ ...p })),
      },
    }
  }
}

module.exports = { Memory }
