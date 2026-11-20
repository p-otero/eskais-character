// glTF 2.0 binary building blocks: accessors over one BIN chunk, quantized morph targets, GLB packing.

export const FLOAT = 5126
export const SHORT = 5122
export const UNSIGNED_BYTE = 5121
export const UNSIGNED_SHORT = 5123
export const UNSIGNED_INT = 5125
export const ARRAY_BUFFER = 34962
export const ELEMENT_ARRAY_BUFFER = 34963

export type Json = Record<string, unknown>

export class GlbBuilder {
  readonly chunks: Uint8Array[] = []
  byteLength = 0
  readonly bufferViews: Json[] = []
  readonly accessors: Json[] = []

  view(data: ArrayBufferView, target?: number, byteStride?: number): number {
    const pad = (4 - (this.byteLength % 4)) % 4
    if (pad > 0) {
      this.chunks.push(new Uint8Array(pad))
      this.byteLength += pad
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const view: Json = { buffer: 0, byteOffset: this.byteLength, byteLength: bytes.byteLength }
    if (target !== undefined) view["target"] = target
    if (byteStride !== undefined) view["byteStride"] = byteStride
    this.chunks.push(bytes.slice())
    this.byteLength += bytes.byteLength
    this.bufferViews.push(view)
    return this.bufferViews.length - 1
  }

  accessor(accessor: Json): number {
    this.accessors.push(accessor)
    return this.accessors.length - 1
  }

  vec3(data: Float32Array, target?: number): number {
    return this.accessor({
      bufferView: this.view(data, target),
      componentType: FLOAT,
      count: data.length / 3,
      type: "VEC3",
      ...bounds(data, 3),
    })
  }

  indices(data: ArrayLike<number>): number {
    let max = 0
    for (let index = 0; index < data.length; index++) max = Math.max(max, data[index] ?? 0)
    const typed = max < 65535 ? Uint16Array.from(data) : Uint32Array.from(data)
    return this.accessor({
      bufferView: this.view(typed, ELEMENT_ARRAY_BUFFER),
      componentType: typed instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT,
      count: typed.length,
      type: "SCALAR",
    })
  }
}

export function bounds(data: ArrayLike<number>, size: number): { min: number[]; max: number[] } {
  const min = Array.from({ length: size }, () => Number.POSITIVE_INFINITY)
  const max = Array.from({ length: size }, () => Number.NEGATIVE_INFINITY)
  for (let index = 0; index < data.length; index++) {
    const axis = index % size
    const value = data[index] ?? 0
    if (value < (min[axis] ?? 0)) min[axis] = value
    if (value > (max[axis] ?? 0)) max[axis] = value
  }
  return { min, max }
}

export function quantizeDelta(value: number): number {
  if (Math.abs(value) >= 1) throw new Error(`A morph delta of ${String(value)} m does not fit a normalized short.`)
  return Math.round(value * 32767)
}

/**
 * Dense normalized-short morph target. Vertex attributes must start each element on 4 bytes, so a 6-byte VEC3 is
 * padded to a stride of 8. min/max are the stored integers, as the validator reads them.
 */
export function denseTarget(builder: GlbBuilder, deltas: Float32Array, offset: number, count: number): number {
  const quantized = new Int16Array(count * 3)
  const padded = new Int16Array(count * 4)
  for (let vertex = 0; vertex < count; vertex++)
    for (let axis = 0; axis < 3; axis++) {
      const value = quantizeDelta(deltas[offset + vertex * 3 + axis] ?? 0)
      quantized[vertex * 3 + axis] = value
      padded[vertex * 4 + axis] = value
    }
  return builder.accessor({
    bufferView: builder.view(padded, ARRAY_BUFFER, 8),
    componentType: SHORT,
    normalized: true,
    count,
    type: "VEC3",
    ...bounds(quantized, 3),
  })
}

/** Sparse normalized-short morph target over the head subset; every other vertex has a zero delta. */
export function sparseTarget(
  builder: GlbBuilder,
  deltas: Float32Array,
  offset: number,
  subsetLength: number,
  vertexCount: number,
  indicesView: number,
): number {
  const quantized = new Int16Array(subsetLength * 3)
  for (let index = 0; index < quantized.length; index++) quantized[index] = quantizeDelta(deltas[offset + index] ?? 0)
  const { min, max } = bounds(quantized, 3)
  if (subsetLength < vertexCount)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis] ?? 0, 0)
      max[axis] = Math.max(max[axis] ?? 0, 0)
    }
  return builder.accessor({
    componentType: SHORT,
    normalized: true,
    count: vertexCount,
    type: "VEC3",
    min,
    max,
    sparse: {
      count: subsetLength,
      indices: { bufferView: indicesView, componentType: UNSIGNED_SHORT },
      values: { bufferView: builder.view(quantized) },
    },
  })
}

export function colorBytes(colors: ArrayLike<number>, count: number): Uint8Array {
  const out = new Uint8Array(count * 4)
  for (let v = 0; v < count; v++) {
    for (let axis = 0; axis < 3; axis++)
      out[v * 4 + axis] = Math.round(Math.min(Math.max(colors[v * 3 + axis] ?? 0, 0), 1) * 255)
    out[v * 4 + 3] = 255
  }
  return out
}

export function singleJointSkin(builder: GlbBuilder, joints: Uint8Array): { JOINTS_0: number; WEIGHTS_0: number } {
  const count = joints.length
  const jointData = new Uint8Array(count * 4)
  const weightData = new Uint8Array(count * 4)
  for (let v = 0; v < count; v++) {
    jointData[v * 4] = joints[v] ?? 0
    weightData[v * 4] = 255
  }
  return {
    JOINTS_0: builder.accessor({
      bufferView: builder.view(jointData, ARRAY_BUFFER),
      componentType: UNSIGNED_BYTE,
      count,
      type: "VEC4",
    }),
    WEIGHTS_0: builder.accessor({
      bufferView: builder.view(weightData, ARRAY_BUFFER),
      componentType: UNSIGNED_BYTE,
      normalized: true,
      count,
      type: "VEC4",
    }),
  }
}

export function packGlb(json: Json, chunks: Uint8Array[], binLength: number): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = text.length + ((4 - (text.length % 4)) % 4)
  const total = 12 + 8 + jsonLength + 8 + binLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(text, 20)
  out.fill(0x20, 20 + text.length, 20 + jsonLength)
  let offset = 20 + jsonLength
  view.setUint32(offset, binLength, true)
  view.setUint32(offset + 4, 0x004e4942, true)
  offset += 8
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export const BYTE = 5120

/** Unit normals as normalized BYTE, padded to a 4-byte stride. */
export function byteNormals(builder: GlbBuilder, data: Float32Array): number {
  const count = data.length / 3
  const padded = new Int8Array(count * 4)
  for (let index = 0; index < count * 3; index++)
    padded[Math.floor(index / 3) * 4 + (index % 3)] = Math.round(Math.min(Math.max(data[index] ?? 0, -1), 1) * 127)
  return builder.accessor({
    bufferView: builder.view(padded, ARRAY_BUFFER, 4),
    componentType: BYTE,
    normalized: true,
    count,
    type: "VEC3",
  })
}

/**
 * A morph target as normalized BYTE, scaled so its largest delta uses the full range: the stored delta is
 * delta / scale, so a weight w must be sent as w × scale (`scale` is returned and goes into `extras.targetScales`).
 * Vertices moving less than `epsilon` metres are dropped; the target is sparse when that leaves under a third of the
 * vertices (5 bytes each), dense otherwise (4 bytes each, VEC3 padded for alignment).
 */
export function byteTarget(
  builder: GlbBuilder,
  vertexCount: number,
  entries: { vertex: number; delta: [number, number, number] }[],
  epsilon: number,
): { accessor: number; scale: number } {
  const moving = entries.filter(
    ({ delta }) => Math.max(Math.abs(delta[0]), Math.abs(delta[1]), Math.abs(delta[2])) > epsilon,
  )
  let scale = 0
  for (const { delta } of moving) scale = Math.max(scale, Math.abs(delta[0]), Math.abs(delta[1]), Math.abs(delta[2]))
  if (scale === 0) scale = 1
  const quantize = (value: number) => Math.round((value / scale) * 127)
  if (moving.length * 3 > vertexCount) {
    const padded = new Int8Array(vertexCount * 4)
    const values = new Int8Array(vertexCount * 3)
    for (const { vertex, delta } of moving)
      for (let axis = 0; axis < 3; axis++) {
        padded[vertex * 4 + axis] = quantize(delta[axis] ?? 0)
        values[vertex * 3 + axis] = quantize(delta[axis] ?? 0)
      }
    const accessor = builder.accessor({
      bufferView: builder.view(padded, ARRAY_BUFFER, 4),
      componentType: BYTE,
      normalized: true,
      count: vertexCount,
      type: "VEC3",
      ...bounds(values, 3),
    })
    return { accessor, scale }
  }
  moving.sort((a, b) => a.vertex - b.vertex)
  const indices = Uint16Array.from(moving, ({ vertex }) => vertex)
  const values = new Int8Array(moving.length * 3)
  moving.forEach(({ delta }, index) => {
    for (let axis = 0; axis < 3; axis++) values[index * 3 + axis] = quantize(delta[axis] ?? 0)
  })
  const { min, max } = bounds(values, 3)
  for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis] ?? 0, 0)
    max[axis] = Math.max(max[axis] ?? 0, 0)
  }
  const accessor = builder.accessor({
    componentType: BYTE,
    normalized: true,
    count: vertexCount,
    type: "VEC3",
    min,
    max,
    ...(moving.length > 0
      ? {
          sparse: {
            count: moving.length,
            indices: { bufferView: builder.view(indices), componentType: UNSIGNED_SHORT },
            values: { bufferView: builder.view(values) },
          },
        }
      : {}),
  })
  return { accessor, scale }
}
