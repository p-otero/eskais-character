import { deflateSync, inflateSync } from "node:zlib"

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "latin1")
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** RGBA8 → PNG with tEXt chunks. Deterministic: fixed filter (none) and zlib level. */
export function encodePng(width: number, height: number, rgba: Uint8Array, text: Record<string, string> = {}): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  }
  const texts = Object.entries(text).map(([key, value]) => chunk("tEXt", Buffer.from(`${key}\0${value}`, "latin1")))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...texts,
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ])
}

export interface DecodedPng {
  width: number
  height: number
  rgba: Uint8Array
  text: Record<string, string>
}

/** Decodes the PNGs this repo writes (8-bit RGBA, any filter) and reads their tEXt chunks. */
export function decodePng(file: Uint8Array): DecodedPng {
  const view = Buffer.from(file)
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  let bitDepth = 0
  const idat: Buffer[] = []
  const text: Record<string, string> = {}
  while (offset < view.length) {
    const length = view.readUInt32BE(offset)
    const type = view.toString("latin1", offset + 4, offset + 8)
    const data = view.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]!
      colorType = data[9]!
    } else if (type === "IDAT") idat.push(data)
    else if (type === "tEXt") {
      const zero = data.indexOf(0)
      text[data.toString("latin1", 0, zero)] = data.toString("latin1", zero + 1)
    }
    offset += 12 + length
  }
  if (bitDepth !== 8 || colorType !== 6)
    throw new Error(`Only 8-bit RGBA PNGs are supported (got depth ${String(bitDepth)}, type ${String(colorType)}).`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[y * stride + x - 4]! : 0
      const up = y > 0 ? rgba[(y - 1) * stride + x]! : 0
      const upLeft = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4]! : 0
      let value = line[x]!
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += Math.floor((left + up) / 2)
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      rgba[y * stride + x] = value & 0xff
    }
  }
  return { width, height, rgba, text }
}
