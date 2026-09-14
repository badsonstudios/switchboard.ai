#!/usr/bin/env node
// Read-only corpus probe for #788 — where do sidechain lines live, and does
// `agentId` actually let us separate two concurrent subagents?
//
// Spawns nothing. Reads ~/.claude/projects/**.jsonl and prints counts.
//
// The premise under test: the issue says the Feed sees interleaved sidechain
// blocks from concurrent subagents. #807 says subagent turns land in SEPARATE
// files. Both cannot be the whole story — measure which lines we actually see.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.join(os.homedir(), '.claude', 'projects')

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

const files = walk(ROOT)

/** A file is a subagent transcript when `subagents` is one of its path segments. */
const isSubagentFile = (f) => f.split(path.sep).includes('subagents')

const stats = {
  files: { parent: 0, subagent: 0 },
  lines: { parent: 0, subagent: 0 },
  bad: 0,
  // lines carrying each field, split by file kind
  field: {},
  // isSidechain:true line counts
  sidechainTrue: { parent: 0, subagent: 0 },
  // which line `type`s carry agentId / attributionAgent
  agentIdTypes: new Map(),
  attributionAgentTypes: new Map(),
  // version ranges
  agentIdVersions: new Set(),
  attributionAgentVersions: new Set(),
  // per-file: distinct agentIds, and whether they INTERLEAVE
  multiAgentFiles: [],
  interleavedFiles: [],
  // agentId -> attributionAgent mapping consistency
  idToNames: new Map(),
  // sidechain lines that carry NO agentId (the degrade-gracefully case)
  sidechainNoAgentId: { parent: 0, subagent: 0 },
  // do subagent files carry isSidechain at all?
  subagentFileSidechainFlag: { true: 0, false: 0, absent: 0 },
  // does a PARENT file ever carry an agentId?
  parentFilesWithAgentId: [],
}

function bump(obj, key) {
  obj[key] = (obj[key] || 0) + 1
}

for (const f of files) {
  const kind = isSubagentFile(f) ? 'subagent' : 'parent'
  stats.files[kind]++
  let text
  try {
    text = fs.readFileSync(f, 'utf8')
  } catch {
    continue
  }
  /** @type {string[]} ordered agentIds seen on this file's lines */
  const order = []
  let sawAgentIdHere = false

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      stats.bad++
      continue
    }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) continue
    stats.lines[kind]++

    for (const k of ['agentId', 'attributionAgent', 'attributionSkill', 'attributionMcpServer', 'attributionMcpTool', 'isSidechain']) {
      if (Object.prototype.hasOwnProperty.call(o, k)) {
        stats.field[k] ??= { parent: 0, subagent: 0 }
        stats.field[k][kind]++
      }
    }

    const hasSide = Object.prototype.hasOwnProperty.call(o, 'isSidechain')
    if (hasSide && o.isSidechain === true) stats.sidechainTrue[kind]++

    if (kind === 'subagent') {
      if (!hasSide) stats.subagentFileSidechainFlag.absent++
      else stats.subagentFileSidechainFlag[String(o.isSidechain)] =
        (stats.subagentFileSidechainFlag[String(o.isSidechain)] || 0) + 1
    }

    const id = typeof o.agentId === 'string' ? o.agentId : null
    if (id) {
      sawAgentIdHere = true
      order.push(id)
      bump(stats.agentIdTypes, o.type)
      stats.agentIdTypes.set(o.type, (stats.agentIdTypes.get(o.type) || 0) + 1)
      if (typeof o.version === 'string') stats.agentIdVersions.add(o.version)
    }
    if (typeof o.attributionAgent === 'string') {
      stats.attributionAgentTypes.set(
        o.type,
        (stats.attributionAgentTypes.get(o.type) || 0) + 1,
      )
      if (typeof o.version === 'string') stats.attributionAgentVersions.add(o.version)
      if (id) {
        if (!stats.idToNames.has(id)) stats.idToNames.set(id, new Set())
        stats.idToNames.get(id).add(o.attributionAgent)
      }
    }
    if (hasSide && o.isSidechain === true && !id) stats.sidechainNoAgentId[kind]++
  }

  if (sawAgentIdHere && kind === 'parent') stats.parentFilesWithAgentId.push(f)

  const distinct = new Set(order)
  if (distinct.size > 1) {
    stats.multiAgentFiles.push({ f: path.relative(ROOT, f), n: distinct.size, kind })
    // interleaved == the run-length-encoded sequence has more runs than distinct ids
    let runs = 1
    for (let i = 1; i < order.length; i++) if (order[i] !== order[i - 1]) runs++
    if (runs > distinct.size) {
      stats.interleavedFiles.push({
        f: path.relative(ROOT, f),
        ids: distinct.size,
        runs,
        kind,
      })
    }
  }
}

const mapOut = (m) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ')

console.log('=== #788 agent attribution probe ===')
console.log(`files: parent=${stats.files.parent} subagent=${stats.files.subagent}`)
console.log(`lines: parent=${stats.lines.parent} subagent=${stats.lines.subagent} unparseable=${stats.bad}`)
console.log('')
console.log('--- field occurrences (parent / subagent files) ---')
for (const [k, v] of Object.entries(stats.field)) {
  console.log(`  ${k}: parent=${v.parent} subagent=${v.subagent}`)
}
console.log('')
console.log(`isSidechain:true  parent=${stats.sidechainTrue.parent} subagent=${stats.sidechainTrue.subagent}`)
console.log(`subagent-file isSidechain flag: ${JSON.stringify(stats.subagentFileSidechainFlag)}`)
console.log(`sidechain:true lines WITHOUT agentId: parent=${stats.sidechainNoAgentId.parent} subagent=${stats.sidechainNoAgentId.subagent}`)
console.log('')
console.log(`agentId line types: ${mapOut(stats.agentIdTypes)}`)
console.log(`attributionAgent line types: ${mapOut(stats.attributionAgentTypes)}`)
console.log(`agentId versions: ${[...stats.agentIdVersions].sort().join(', ')}`)
console.log(`attributionAgent versions: ${[...stats.attributionAgentVersions].sort().join(', ')}`)
console.log('')
console.log(`PARENT files carrying any agentId: ${stats.parentFilesWithAgentId.length}`)
for (const f of stats.parentFilesWithAgentId.slice(0, 10)) {
  console.log(`   ${path.relative(ROOT, f)}`)
}
console.log('')
console.log(`files with >1 distinct agentId: ${stats.multiAgentFiles.length}`)
console.log(`  of those, parent: ${stats.multiAgentFiles.filter((x) => x.kind === 'parent').length}`)
console.log(`files where agentIds INTERLEAVE (runs > distinct ids): ${stats.interleavedFiles.length}`)
for (const x of stats.interleavedFiles.slice(0, 15)) {
  console.log(`   [${x.kind}] ids=${x.ids} runs=${x.runs}  ${x.f}`)
}
console.log('')
const multiName = [...stats.idToNames.entries()].filter(([, s]) => s.size > 1)
console.log(`agentIds with >1 distinct attributionAgent name: ${multiName.length}`)
console.log(`distinct agentIds seen with a name: ${stats.idToNames.size}`)
const names = new Set()
for (const s of stats.idToNames.values()) for (const n of s) names.add(n)
console.log(`distinct attributionAgent names: ${[...names].sort().join(', ')}`)
