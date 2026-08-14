/**
 * 澶嶇幇骞堕獙璇併€屽巻鍙插鍥?+ 鏂板浘銆嶇殑鍚嶉鍒嗛厤锛坆atchMaxImages 鏈懡涓紭鍏堬級锛? *  1. 鏂颁細璇濅緷娆″彂 4 寮犱笉鍚屽浘锛堝缓绔?4 涓弿杩扮紦瀛樻潯鐩級锛? *  2. 鍐?read_image 绗?5 寮狅紙鏈懡涓級鈫?淇鍓嶄細婧㈠嚭涓哄崰浣嶏紝淇鍚庡簲鑾峰緱鎻忚堪锛? * 鍒ゅ畾锛氬伐鍏风粨鏋滆疆鐨勭敤鎴锋秷鎭噷搴斿嚭鐜般€孾鐢ㄦ埛闄勫浘 鈥︼紙mimo-v2.5锛夛細鈥︺€嶈€岄潪
 * 銆岃緟鍔╄瑙夋ā鍨嬫殏涓嶅彲鐢ㄣ€嶃€? */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const POLL_TIMEOUT_MS = 300_000
const FIXTURES = dirname(fileURLToPath(import.meta.url)) + '/../test-fixtures'

async function rpc(method, payload) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  if (!res.ok) throw new Error(`carrier ${res.status} for ${method}`)
  return res.json()
}

function ok(envelope) {
  if (envelope.result?.ok) return envelope.result.value
  const error = envelope.result?.error
  throw new Error(`${error?.code ?? 'unknown'}: ${error?.message ?? JSON.stringify(envelope).slice(0, 200)}`)
}

function imagePart(file) {
  return {
    type: 'image',
    mediaType: 'image/png',
    data: readFileSync(join(FIXTURES, file)).toString('base64'),
    name: file,
  }
}

async function waitTurn(sessionId, baselineTurnEnds) {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const value = ok(await rpc('session.history', { sessionId, maxMessages: 80 }))
    const events = value.events.map(entry => entry.event)
    const turnEnds = events.filter(event => event.type === 'turn/end').length
    if (turnEnds > baselineTurnEnds) return events
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  throw new Error('timeout waiting for the turn to complete')
}

function allText(blocks) {
  const parts = []
  const walk = list => {
    for (const block of list) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      if (Array.isArray(block?.content)) walk(block.content)
    }
  }
  walk(blocks)
  return parts.join('\n')
}

async function main() {
  console.log('== budget 鍚嶉鍒嗛厤楠岃瘉 @', BASE, '==')
  const created = ok(await rpc('session.create', { cwd: process.env.DSH_TEST_CWD ?? 'C:\\dsh-aux-vision' }))
  const sid = created.sessionId
  console.log('[1] session:', sid)

  // 1. 渚濇鍙?4 寮犱笉鍚屽浘锛堟瘡寮犲缓绔嬬紦瀛樻潯鐩級
  let turnEnds = 0
  for (let i = 1; i <= 4; i++) {
    const file = `colors-${i}.png`
    ok(await rpc('session.prompt', {
      sessionId: sid,
      mode: 'queue',
      content: [imagePart(file), { type: 'text', text: `杩欐槸绗?${i} 寮犲浘锛屽彧鍥炵瓟锛氬凡鏀跺埌銆俙 }],
    }))
    const events = await waitTurn(sid, turnEnds)
    turnEnds = events.filter(e => e.type === 'turn/end').length
    console.log(`[1.${i}] ${file} 宸插彂閫佸苟瀹屾垚涓€杞甡)
  }

  // 2. read_image 绗?5 寮狅紙鏈懡涓級
  ok(await rpc('session.prompt', {
    sessionId: sid,
    mode: 'queue',
    content: [{ type: 'text', text: '璇风敤 read_image 宸ュ叿鏌ョ湅 test-fixtures/colors-5.png锛岀劧鍚庡憡璇夋垜涓ぎ鏂瑰潡鐨勯鑹层€? }],
  }))
  console.log('[2] read_image colors-5.png 宸插彂閫侊紝绛夊緟鍥炲悎鈥︹€?)
  const events = await waitTurn(sid, turnEnds)

  // 3. 妫€鏌ュ伐鍏风粨鏋滆疆鐨勭敤鎴锋秷鎭敞鍏?  let injected = false
  let marker = false
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const text = allText(event.data?.message?.content ?? event.data?.content ?? [])
    if (text.includes('[鐢ㄦ埛闄勫浘')) injected = true
    if (text.includes('杈呭姪瑙嗚妯″瀷鏆備笉鍙敤')) marker = true
  }
  const last = [...events].reverse().find(e => e.type === 'assistant/message')
  const reply = allText(last?.data?.message?.content ?? [])
  console.log(`[3] 娉ㄥ叆鎻忚堪: ${injected ? '鉁? : '鉁?} | 鍑虹幇鍗犱綅 marker: ${marker ? '鉁?bug 澶嶇幇)' : '鉁?} `)
  console.log('[3] 鍥炲锛堝墠 300锛?', reply.slice(0, 300))
  if (injected && !marker) {
    console.log('\n== 閫氳繃锛氱 5 寮犳柊鍥捐幏寰楁弿杩帮紙缂撳瓨鍥炬湭鍗犲悕棰濓級==')
  } else {
    console.log('\n== 澶辫触锛氭柊鍥句粛琚崰浣?==')
    process.exit(2)
  }
}

main().catch(error => {
  console.error('楠岃瘉澶辫触:', error)
  process.exit(1)
})
