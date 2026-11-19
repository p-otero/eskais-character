// Performance budgets (tooling/perf/budgets.json) on the committed fixtures: stage times and model load with headroom
// for slower machines, download and GLB sizes (5%), memory (25%), no main-thread task over 50 ms.
// Usage: bun tooling/perf/ci.ts [--no-build] [--update]. Over budget: make it fit, or --update and say why.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildHarness } from "../browser/build-harness.mjs"
import { fixture, manifest } from "../browser/fixtures.mjs"
import { downloadSizes, runBench, stageSummary } from "./bench.mjs"

interface Budgets {
  timeHeadroom: number
  stagesMs: Record<string, number>
  initMs: number
  longTasksOver50Ms: number
  memoryMiB: number
  glbBytes: number
  downloads: Record<string, { gzip: number; brotli: number }>
}

const budgetsPath = join(import.meta.dirname, "budgets.json")
const update = process.argv.includes("--update")
if (!process.argv.includes("--no-build")) await buildHarness()

const subjects = (manifest.subjects as { id: string }[]).map((subject) => ({
  id: subject.id,
  face: fixture(subject.id, "face"),
  body: fixture(subject.id, "body"),
}))
// One warm-up scan, so the first scan's JIT and allocation cost don't count against the stage budgets.
const run = await runBench("desktopCpu", [subjects[0]!, ...subjects])
run.scans.shift()
const stages = stageSummary(run) as Record<string, number>
const measured = {
  stagesMs: stages,
  initMs: run.initMs as number,
  longTasksOver50Ms: (run.longTasks as number[]).filter((ms) => ms > 50).length,
  memoryMiB: run.memoryBytes ? (run.memoryBytes as number) / 2 ** 20 : null,
  glbBytes: Math.max(...(run.scans as { glbBytes: number }[]).map((scan) => scan.glbBytes)),
  downloads: Object.fromEntries(
    (downloadSizes() as { name: string; gzip: number; brotli: number }[])
      .filter((file) => !file.name.includes("harness"))
      .map((file) => [file.name, { gzip: file.gzip, brotli: file.brotli }]),
  ),
}
mkdirSync(join(import.meta.dirname, "results"), { recursive: true })
writeFileSync(
  join(import.meta.dirname, "results/ci.json"),
  JSON.stringify({ date: new Date().toISOString(), measured }, null, 2) + "\n",
)

if (update || !existsSync(budgetsPath)) {
  const timeHeadroom = 4
  const budgets: Budgets = {
    timeHeadroom,
    stagesMs: Object.fromEntries(
      Object.entries(stages).map(([stage, ms]) => [stage, Math.ceil(Math.max(ms, 5) * timeHeadroom)]),
    ),
    initMs: Math.ceil(measured.initMs * timeHeadroom),
    longTasksOver50Ms: 0,
    memoryMiB: Math.ceil((measured.memoryMiB ?? 128) * 1.25),
    glbBytes: Math.ceil(measured.glbBytes * 1.05),
    downloads: Object.fromEntries(
      Object.entries(measured.downloads).map(([name, size]) => [
        name,
        { gzip: Math.ceil(size.gzip * 1.05), brotli: Math.ceil(size.brotli * 1.05) },
      ]),
    ),
  }
  writeFileSync(budgetsPath, JSON.stringify(budgets, null, 2) + "\n")
  console.log(`Wrote ${budgetsPath}.`)
}

const budgets = JSON.parse(readFileSync(budgetsPath, "utf8")) as Budgets
const rows: { metric: string; measured: number; budget: number }[] = []
for (const [stage, budget] of Object.entries(budgets.stagesMs))
  rows.push({ metric: `stage ${stage} (ms, median)`, measured: stages[stage] ?? 0, budget })
rows.push({ metric: "models ready (ms)", measured: measured.initMs, budget: budgets.initMs })
rows.push({
  metric: "main-thread tasks > 50 ms",
  measured: measured.longTasksOver50Ms,
  budget: budgets.longTasksOver50Ms,
})
if (measured.memoryMiB !== null)
  rows.push({ metric: "memory (MiB, page + worker)", measured: measured.memoryMiB, budget: budgets.memoryMiB })
rows.push({ metric: "character GLB (bytes)", measured: measured.glbBytes, budget: budgets.glbBytes })
for (const [name, budget] of Object.entries(budgets.downloads)) {
  const size = measured.downloads[name]
  if (!size) continue
  rows.push({ metric: `${name} gzip (bytes)`, measured: size.gzip, budget: budget.gzip })
  rows.push({ metric: `${name} brotli (bytes)`, measured: size.brotli, budget: budget.brotli })
}
const over = rows.filter((row) => row.measured > row.budget)
const width = Math.max(...rows.map((row) => row.metric.length))
for (const row of rows)
  console.log(
    `${row.measured > row.budget ? "OVER" : "ok  "} ${row.metric.padEnd(width)} ${row.measured.toFixed(0).padStart(10)} / ${String(row.budget).padStart(10)}`,
  )
if (over.length > 0) {
  console.error(
    `\n${String(over.length)} metric(s) over budget. Make the change fit, or run with --update and say why in the commit.`,
  )
  process.exitCode = 1
}
