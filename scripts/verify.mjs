/**
 * 绔埌绔獙璇佽剼鏈紙鏈湴 DSH Web API锛宧ttp://127.0.0.1:3080锛夈€? *
 * 姝ラ锛? *  1. 鍒涘缓鏂颁細璇濓紙cwd = dsh-aux-vision锛? *  2. 鏌ヨ浼氳瘽妯″瀷锛堝簲鏄剧ず opencode-go/deepseek-v4-flash锛? *  3. 鍙戝浘 + 鎻愰棶 鈫?鏈熸湜 accepted:true锛堟彃浠舵斁琛屽噯鍏ワ級
 *     - 杞鍘嗗彶锛氱敤鎴锋秷鎭簲鍚€孾鐢ㄦ埛闄勫浘 鈥︺€嶆敞鍏ユ枃鏈紱鍔╃悊鍥炲搴斾綋鐜板浘鐗囦俊鎭紙绾?缁?钃?鐧借壊鏂瑰潡锛? *  4. 绾枃鏈疆 鈫?鍥炲涓嶅簲鍚€孾鐢ㄦ埛闄勫浘銆嶆垨銆孾鍥剧墖闄勪欢銆嶏紙鏃犳敞鍏?= 鏃犺瑙夎皟鐢ㄨ矾寰勶級
 *  5. read_image 璺緞锛氳妯″瀷鐢?read_image 璇?test-fixtures/colors.png 鈫?鍥炲搴斾綋鐜板浘鐗囧唴瀹? *
 * 鐢ㄦ硶锛歯ode scripts/verify.mjs [--image-round-only]
 */
const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const POLL_TIMEOUT_MS = 180_000
const STEP_TIMEOUT_MS = 90_000

async function rpc(method, payload) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method,
      payload,
    }),
  })
  if (!res.ok) throw new Error(`carrier ${res.status} for ${method}`)
  return res.json()
}

/** 浼犲叆瀹屾暣淇″皝 {type,rpcId,result}銆?*/
function ok(envelope) {
  if (envelope.result?.ok) return envelope.result.value
  const error = envelope.result?.error
  throw new Error(`${error?.code ?? 'unknown'}: ${error?.message ?? JSON.stringify(envelope).slice(0, 200)}`)
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  const walk = (list) => {
    for (const block of list) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      if (Array.isArray(block?.content)) walk(block.content)
    }
  }
  walk(blocks)
  return parts.join('\n')
}

function lastAssistantText(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const text = textOf(event.data?.message?.content)
    if (text !== '') return text
  }
  return undefined
}

function lastUserMessage(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'user/message') return event.data
  }
  return undefined
}

async function waitForTurn(sessionId, baselineTurnEnds) {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const value = ok(await rpc('session.history', { sessionId, maxMessages: 60 }))
    const events = value.events.map(entry => entry.event)
    const turnEnds = events.filter(event => event.type === 'turn/end').length
    if (turnEnds > baselineTurnEnds) return events
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  throw new Error('timeout waiting for the turn to complete')
}

/** 鍏ㄩ儴鐢ㄦ埛娑堟伅锛堣烦杩?runtime context 绛夋敞鍏ユ秷鎭級銆?*/
function allUserMessages(events) {
  const out = []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const message = event.data?.message ?? event.data
    const text = textOf(message?.content)
    const hasImage = JSON.stringify(message?.content ?? []).includes('"type":"image"')
    if (text === '' && !hasImage) continue
    out.push({ text, hasImage })
  }
  return out
}

async function main() {
  const imageRoundOnly = process.argv.includes('--image-round-only')
  console.log(`== dsh-aux-vision 绔埌绔獙璇?@ ${BASE} ==`)

  // 1. 鍒涘缓浼氳瘽
  const created = ok(await rpc('session.create', { cwd: process.env.DSH_TEST_CWD ?? 'C:\\dsh-aux-vision' }))
  const sessionId = created.sessionId
  console.log(`[1] session created: ${sessionId}`)

  // 2. 浼氳瘽妯″瀷
  const models = ok(await rpc('session.models', { sessionId }))
  console.log(`[2] current model: ${models.current?.provider}/${models.current?.model} (routable=${models.routable})`)

  // 3. 鍙戝浘
  const fs = await import('node:fs')
  const data = fs.readFileSync(new URL('../test-fixtures/colors.png', import.meta.url)).toString('base64')
  const promptResult = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [
      { type: 'image', mediaType: 'image/png', data, name: 'colors.png' },
      { type: 'text', text: '璇锋弿杩拌繖寮犲浘鐗囩殑鍐呭锛堥鑹蹭笌甯冨眬锛夛紝骞跺憡璇夋垜涓ぎ鏂瑰潡鐨勯鑹层€? },
    ],
  })
  if (!promptResult.result?.ok) {
    console.log(`[3] 鉁?image prompt REJECTED: ${promptResult.result?.error?.code} 鈥?${promptResult.result?.error?.message}`)
    console.log('    锛堟彃浠舵湭鐢熸晥锛氱‘璁?dsh-aux-vision 宸叉寕杞藉苟閲嶈浇閰嶇疆锛?)
    process.exit(1)
  }
  console.log('[3] image prompt accepted (鍑嗗叆瀹堝崼宸叉斁琛?')

  const events1 = await waitForTurn(sessionId, 0)
  const users1 = allUserMessages(events1)
  const assistant1 = lastAssistantText(events1) ?? ''
  console.log(`[3] 鐢ㄦ埛娑堟伅锛堝叡 ${users1.length} 鏉★級:`)
  for (const user of users1) {
    console.log(`    - [image=${user.hasImage}] ${user.text.slice(0, 300)}`)
  }
  console.log(`[3] assistant reply (鍓?600 瀛?: ${assistant1.slice(0, 600)}`)
  const injected = users1.some(user => user.text.includes('[鐢ㄦ埛闄勫浘'))
  const mentionsColors = /绾缁縷钃潀鐧?.test(assistant1)
  console.log(`[3] 娉ㄥ叆鎻忚堪: ${injected ? '鉁? : '鉁?} | 鍥炲浣撶幇棰滆壊淇℃伅: ${mentionsColors ? '鉁? : '鉁?}`)

  if (imageRoundOnly) return

  // 4. 绾枃鏈疆
  ok(await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '鐜板湪璇峰彧鍥炲涓や釜瀛楋細浣犲ソ銆? }],
  }))
  const events2 = await waitForTurn(sessionId, events1.filter(event => event.type === 'turn/end').length)
  const assistant2 = lastAssistantText(events2) ?? ''
  const noInjection = !assistant2.includes('[鐢ㄦ埛闄勫浘') && !assistant2.includes('[鍥剧墖闄勪欢')
  console.log(`[4] text-only reply (鍓?200 瀛?: ${assistant2.slice(0, 200)}`)
  console.log(`[4] 鏃犳敞鍏?鏃犲崰浣? ${noInjection ? '鉁? : '鉁?}`)

  // 5. read_image 璺緞
  ok(await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '璇风敤 read_image 宸ュ叿鏌ョ湅 test-fixtures/colors.png锛岀劧鍚庢弿杩板浘鐗囧唴瀹广€? }],
  }))
  const events3 = await waitForTurn(sessionId, events2.filter(event => event.type === 'turn/end').length)
  const assistant3 = lastAssistantText(events3) ?? ''
  console.log(`[5] read_image 璺緞鍥炲 (鍓?600 瀛?: ${assistant3.slice(0, 600)}`)
  const mentions = /绾缁縷钃潀鐧?.test(assistant3)
  console.log(`[5] read_image 鍥炲浣撶幇鍥剧墖淇℃伅: ${mentions ? '鉁? : '鉁?}`)

  console.log('\n== 楠岃瘉缁撴潫 ==')
  if (!injected || !mentionsColors || !noInjection || !mentions) process.exit(2)
}

main().catch(error => {
  console.error('楠岃瘉澶辫触:', error)
  process.exit(1)
})
