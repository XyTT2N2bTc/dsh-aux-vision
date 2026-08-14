/**
 * 生成确定性测试图（无第三方依赖的极简 PNG 编码器）。
 * 图样：120x80，上红（0-31 行）、中绿（32-47 行）、下蓝（48-79 行）三色横带，
 * 中央白色方块（x 50-69，y 30-49）——视觉模型应能准确描述，便于核对。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

export function makePng(width, height, pixelFn) {
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y)
      const o = rowStart + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const WIDTH = 120
const HEIGHT = 80

function pixel(x, y) {
  // 中央白色方块
  if (x >= 50 && x < 70 && y >= 30 && y < 50) return [255, 255, 255]
  if (y < 32) return [255, 0, 0] // 上红
  if (y < 48) return [0, 255, 0] // 中绿
  return [0, 0, 255] // 下蓝
}

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures')
mkdirSync(outDir, { recursive: true })
const out = resolve(outDir, 'colors.png')
writeFileSync(out, makePng(WIDTH, HEIGHT, pixel))
console.log(`wrote ${out} (${WIDTH}x${HEIGHT})`)
