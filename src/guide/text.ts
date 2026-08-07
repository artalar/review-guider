/**
 * UTF-8 codec, hand-rolled so the pure layer needs neither `node:buffer` nor
 * the `TextEncoder` global. Used by the diff digest and by git's octal path
 * quoting.
 */

export function utf8Encode(input: string): number[] {
  const out: number[] = []
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < input.length) {
      const low = input.charCodeAt(i + 1)
      if (low >= 0xDC00 && low <= 0xDFFF) {
        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
        i++
      }
    }
    if (code < 0x80) {
      out.push(code)
    }
    else if (code < 0x800) {
      out.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F))
    }
    else if (code < 0x10000) {
      out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F))
    }
    else {
      out.push(
        0xF0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3F),
        0x80 | ((code >> 6) & 0x3F),
        0x80 | (code & 0x3F),
      )
    }
  }
  return out
}

/** Lenient: malformed sequences decode to U+FFFD rather than throwing. */
export function utf8Decode(bytes: readonly number[]): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i] & 0xFF
    let code: number
    let size: number
    if (b0 < 0x80) {
      code = b0
      size = 1
    }
    else if ((b0 & 0xE0) === 0xC0) {
      code = b0 & 0x1F
      size = 2
    }
    else if ((b0 & 0xF0) === 0xE0) {
      code = b0 & 0x0F
      size = 3
    }
    else if ((b0 & 0xF8) === 0xF0) {
      code = b0 & 0x07
      size = 4
    }
    else {
      out += '\uFFFD'
      i++
      continue
    }
    if (i + size > bytes.length) {
      out += '\uFFFD'
      break
    }
    let valid = true
    for (let k = 1; k < size; k++) {
      const bk = bytes[i + k] & 0xFF
      if ((bk & 0xC0) !== 0x80) {
        valid = false
        break
      }
      code = (code << 6) | (bk & 0x3F)
    }
    if (!valid) {
      out += '\uFFFD'
      i++
      continue
    }
    i += size
    if (code > 0x10FFFF) {
      out += '\uFFFD'
    }
    else if (code >= 0x10000) {
      const c = code - 0x10000
      out += String.fromCharCode(0xD800 + (c >> 10), 0xDC00 + (c & 0x3FF))
    }
    else {
      out += String.fromCharCode(code)
    }
  }
  return out
}
