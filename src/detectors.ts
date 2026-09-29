/** Pure bounded detectors shared by streaming and tool orchestration. */
import { createHash } from 'node:crypto'
import type { Settings } from './config.js'

/** Stable JSON digest; inputs are parsed tool JSON, never stored in notices. */
export function digest(value: unknown): string {
  function sorted(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sorted)
    if (v !== null && typeof v === 'object') {
      const r = v as Record<string, unknown>
      return Object.fromEntries(Object.keys(r).sort().map(k => [k, sorted(r[k])]))
    }
    return v
  }
  return createHash('sha256').update(JSON.stringify(sorted(value)) ?? 'null').digest('hex')
}

/** Word similarity is a heuristic, not semantic understanding. */
export function similar(a: string, b: string, threshold: number): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
  const x = words(a), y = words(b)
  if (x.size < 20 || y.size < 20) return false
  let intersection = 0
  for (const word of x) if (y.has(word)) intersection++
  return intersection / (x.size + y.size - intersection) >= threshold
}

/** One text block; fence state survives bounded-window truncation. */
export class TextDetector {
  private line = ''
  private fence = ''
  private paragraph = ''
  private prose = ''
  private sinceCheck = 0
  private paragraphs: string[] = []
  private hit: string | undefined
  constructor(private readonly settings: Settings, private readonly kind: 'reasoning' | 'text') {}

  /** Feed a delta; code fences and their contents do not participate. */
  push(delta: string): string | undefined {
    for (const char of delta) {
      this.line += char
      if (char === '\n') {
        const fence = this.line.match(/^\s*(`{3,}|~{3,})/u)?.[1]
        if (fence) {
          if (!this.fence) this.fence = fence[0]
          else if (this.fence === fence[0]) this.fence = ''
          this.paragraph = ''
          this.prose = ''
        } else if (!this.fence) {
          this.prose = (this.prose + this.line).slice(-this.settings.maxTextWindow)
          if (!this.line.trim()) this.endParagraph()
          else this.paragraph = (this.paragraph + this.line).slice(-this.settings.maxTextWindow)
        }
        this.line = ''
      }
      // Long single-line generations must also be bounded and monitored.
      if (this.line.length > this.settings.maxTextWindow * 2) {
        this.line = this.line.slice(-this.settings.maxTextWindow)
      }
      if (++this.sinceCheck >= this.settings.checkStride) {
        this.sinceCheck = 0
        this.check()
      }
      if (this.hit) return this.hit
    }
    return undefined
  }

  /** Check the last partial stride and paragraph at block termination. */
  finish(): string | undefined {
    this.check()
    if (!this.fence && !/^\s*(`{3,}|~{3,})/u.test(this.line)) {
      this.paragraph += this.line
      this.endParagraph()
    }
    return this.hit
  }

  private endParagraph(): void {
    const text = this.paragraph.trim().replace(/^\d+[.)]\s*/u, '').replace(/\s+/gu, ' ')
    this.paragraph = ''
    if (text.length < this.settings.paragraphMinChars) return
    this.paragraphs.push(digest(text))
    this.paragraphs = this.paragraphs.slice(-64)
    if (this.paragraphs.filter(p => p === this.paragraphs.at(-1)).length >= this.settings.paragraphRepeats)
      this.hit = `${this.kind}-paragraph-repetition`
  }

  private check(): void {
    if (this.fence || /^\s*(`{3,}|~{3,})/u.test(this.line)) return
    const s = (this.prose + this.line).slice(-this.settings.maxTextWindow)
    const min = this.kind === 'reasoning' ? this.settings.thinkingMinChars : this.settings.outputMinChars
    const repeats = this.settings.textRepeats
    // Reverse Z-array finds adjacent equal suffixes in linear window time.
    const reversed = Array.from(s).reverse().join('')
    const z = new Uint32Array(reversed.length)
    let left = 0, right = 0
    for (let i = 1; i < reversed.length; i++) {
      if (i <= right) z[i] = Math.min(right - i + 1, z[i - left])
      while (i + z[i] < reversed.length && reversed[z[i]] === reversed[i + z[i]]) z[i]++
      if (i + z[i] - 1 > right) { left = i; right = i + z[i] - 1 }
      if (i >= min && i * repeats <= reversed.length && z[i] >= i * (repeats - 1)) {
        this.hit = `${this.kind}-verbatim-repetition`
        return
      }
    }
  }
}

/** Detect a repeated suffix of complete tool identities. */
export function toolCycle(history: string[], key: string, s: Settings): boolean {
  const values = [...history, key]
  for (let width = 1; width <= s.maxCycleLength; width++) {
    const size = width * s.toolCycleRepeats
    if (values.length < size) break
    const end = values.length
    let repeated = true
    for (let i = end - size; i < end - width; i++) {
      if (values[i] !== values[i + width]) { repeated = false; break }
    }
    if (repeated) return true
  }
  return false
}
