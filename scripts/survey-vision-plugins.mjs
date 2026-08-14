/**
 * 批量调研 dsh 视觉类竞品：列文件 → 定位主入口 → 抓关键 API 使用模式。
 * 输出 markdown 表格素材。
 */
const REPOS = [
  'liustack/modlens',
  'Anionex/dsh-vision-toolkit',
  'Flyvhidbwo/dsh-vision-proxy',
  '237229953-create/dsh-vision',
  'lakeofsky347/dsh-vision',
  'Isekai-Mfu/dsh-mimo-vision-hint',
  'william-jin-cmu/dsh-vision',
  'ysr666/dsh-vision-router',
]

const PATTERNS = [
  ["agent/pre-step", "pre-step"],
  ["agent/request", "agent/request"],
  ["llm/stream", "llm/stream"],
  ["tools.register", "tools.register"],
  ["registerAdapter", "registerAdapter"],
  ["resolveModelInfo", "resolveModelInfo"],
  ["prepareCall", "prepareCall"],
  ["system-prompt", "system-prompt"],
  ["system prompt", "system prompt"],
  ["readImage", "readImage"],
  ["attachments", "attachments"],
  ["batchMaxImages|maxImages", "batch"],
  ["cache", "cache"],
  ["fallback|降级", "fallback"],
  ["installCapability|inputModalities", "modality"],
]

async function fileList(repo) {
  const r = await fetch(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, {
    headers: { 'User-Agent': 'dsh-survey' },
  })
  if (!r.ok) return { error: `HTTP ${r.status}` }
  const j = await r.json()
  if (!j.tree) return { error: JSON.stringify(j).slice(0, 120) }
  const blobs = j.tree.filter(t => t.type === 'blob')
  const main = blobs.find(b => /(^|\/)(index|main)\.(js|ts|mjs|cjs)$/.test(b.path))
    ?? blobs.find(b => /\.(js|ts|mjs|cjs)$/.test(b.path) && /(src|lib)/.test(b.path))
    ?? blobs.find(b => /\.(js|ts|mjs|cjs)$/.test(b.path))
  return { files: blobs.map(b => b.path), main: main?.path, size: main?.size }
}

async function raw(repo, path) {
  const r = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${encodeURIComponent(path)}`, {
    headers: { 'User-Agent': 'dsh-survey' },
  })
  if (!r.ok) return undefined
  return r.text()
}

for (const repo of REPOS) {
  console.log(`\n===== ${repo} =====`)
  const list = await fileList(repo)
  if (list.error) { console.log('ERR:', list.error); continue }
  console.log(`files: ${list.files.length} | main: ${list.main} (${list.size}B)`)
  if (!list.main) continue
  const code = await raw(repo, list.main)
  if (code === undefined) { console.log('ERR: raw fetch failed'); continue }
  const hits = []
  for (const [pattern, label] of PATTERNS) {
    const re = new RegExp(pattern, 'i')
    const count = (code.match(re) ?? []).length
    if (count > 0) hits.push(`${label}x${count}`)
  }
  console.log('API 模式:', hits.join(' ') || '(none)')
  // 依赖
  const pkg = await raw(repo, 'package.json')
  if (pkg) {
    try {
      const j = JSON.parse(pkg)
      const deps = { ...(j.dependencies ?? {}), ...(j.peerDependencies ?? {}) }
      const names = Object.keys(deps).filter(n => !n.startsWith('@deepseek-ai'))
      console.log('依赖(非 dsh):', names.join(', ') || '(无)')
    } catch { console.log('package.json 解析失败') }
  }
  // 关键摘要：前 40 行注释
  const head = code.split('\n').slice(0, 40).filter(l => /^\s*(\/\/|\/\*|\*|#)/.test(l)).join(' | ').slice(0, 600)
  if (head) console.log('头部注释:', head)
  await new Promise(r => setTimeout(r, 900))
}
