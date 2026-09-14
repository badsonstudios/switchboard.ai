#!/usr/bin/env node
// #788 probe 2 — do two subagents of the SAME parent actually overlap in time,
// and what does the `.meta.json` beside each subagent file carry?
//
// Probe 1 established that `agentId` never appears in a parent transcript and
// that each subagent file holds exactly one agentId. So any interleaving the
// Feed shows would come from US merging N files, ordered by timestamp. This
// measures whether that merge would actually interleave.
//
// Read-only. Spawns nothing.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.join(os.homedir(), '.claude', 'projects')

/** @returns {string[]} every `<slug>/<uuid>/subagents` directory */
function subagentDirs(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    if (e.name === 'subagents') out.push(p)
    else subagentDirs(p, out)
  }
  return out
}

const dirs = subagentDirs(ROOT)

let parentsWithMultipleAgents = 0
let parentsWithOverlap = 0
const metaKeys = new Map()
let metaFiles = 0
let jsonlWithoutMeta = 0
const overlapExamples = []
const perParentCounts = []

for (const dir of dirs) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  /** @type {Array<{id:string,first:number,last:number,n:number,name?:string}>} */
  const spans = []

  for (const f of files) {
    const full = path.join(dir, f)
    let text
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    let first = Infinity
    let last = -Infinity
    let n = 0
    let id = null
    let name
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (!o || typeof o !== 'object') continue
      if (typeof o.agentId === 'string') id = o.agentId
      if (typeof o.attributionAgent === 'string') name ??= o.attributionAgent
      const t = Date.parse(o.timestamp)
      if (Number.isFinite(t)) {
        if (t < first) first = t
        if (t > last) last = t
        n++
      }
    }
    if (id && n > 0) spans.push({ id, first, last, n, name })

    // the meta file that should sit beside it
    const meta = full.replace(/\.jsonl$/, '.meta.json')
    if (fs.existsSync(meta)) {
      metaFiles++
      try {
        const m = JSON.parse(fs.readFileSync(meta, 'utf8'))
        for (const k of Object.keys(m)) metaKeys.set(k, (metaKeys.get(k) || 0) + 1)
      } catch {
        /* ignore */
      }
    } else {
      jsonlWithoutMeta++
    }
  }

  perParentCounts.push(spans.length)
  if (spans.length < 2) continue
  parentsWithMultipleAgents++

  spans.sort((a, b) => a.first - b.first)
  let overlapped = false
  for (let i = 1; i < spans.length; i++) {
    for (let j = 0; j < i; j++) {
      // half-open overlap: A starts before B ends and B starts before A ends
      if (spans[i].first < spans[j].last && spans[j].first < spans[i].last) {
        overlapped = true
        if (overlapExamples.length < 8) {
          overlapExamples.push({
            dir: path.relative(ROOT, dir),
            a: `${spans[j].name ?? '?'}(${spans[j].n} lines)`,
            b: `${spans[i].name ?? '?'}(${spans[i].n} lines)`,
            overlapMs:
              Math.min(spans[i].last, spans[j].last) - Math.max(spans[i].first, spans[j].first),
          })
        }
      }
    }
  }
  if (overlapped) parentsWithOverlap++
}

const hist = new Map()
for (const c of perParentCounts) hist.set(c, (hist.get(c) || 0) + 1)

console.log('=== #788 probe 2: subagent concurrency + meta shape ===')
console.log(`parent sessions with a subagents/ dir: ${dirs.length}`)
console.log(
  `subagents per parent (count -> parents): ${[...hist.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k}->${v}`)
    .join(' ')}`,
)
console.log(`parents with >=2 subagents: ${parentsWithMultipleAgents}`)
console.log(`parents where two subagents OVERLAP in time: ${parentsWithOverlap}`)
for (const x of overlapExamples) {
  console.log(`   ${x.dir}  ${x.a} <-> ${x.b}  overlap=${Math.round(x.overlapMs / 1000)}s`)
}
console.log('')
console.log(`.meta.json files found: ${metaFiles}  (jsonl with no meta: ${jsonlWithoutMeta})`)
console.log(
  `meta keys: ${[...metaKeys.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}`,
)
