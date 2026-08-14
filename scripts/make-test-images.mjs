/**
 * 生成多张确定性测试图（用于复现「历史多图 + 新图」的名额分配场景）。
 * 每张 120x80，两条水平色带 + 中央小方块，颜色组合各不相同。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makePng } from './make-test-image.mjs'

const PALETTES = [
  { top: [255, 128, 0], bottom: [0, 128, 255], square: [255, 255, 255] }, // 橙/蓝/白
  { top: [128, 0, 255], bottom: [255, 255, 0], square: [0, 0, 0] },       // 紫/黄/黑
  { top: [0, 200, 0], bottom: [255, 0, 200], square: [255, 255, 255] },   // 绿/粉/白
  { top: [255, 255, 255], bottom: [0, 0, 0], square: [255, 0, 0] },       // 白/黑/红
  { top: [0, 200, 255], bottom: [255, 100, 0], square: [0, 255, 0] },     // 青/橙/绿
]

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures')
mkdirSync(outDir, { recursive: true })

for (let i = 0; i < PALETTES.length; i++) {
  const { top, bottom, square } = PALETTES[i]
  const png = makePng(120, 80, (x, y) => {
    if (x >= 50 && x < 70 && y >= 30 && y < 50) return square
    return y < 40 ? top : bottom
  })
  writeFileSync(resolve(outDir, `colors-${i + 1}.png`), png)
}
console.log(`wrote ${PALETTES.length} images to ${outDir}`)
