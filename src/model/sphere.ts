/** Unit icosphere: shared by the eyes and the hair buns. */
export function icosphere(subdivisions: number): { positions: Float32Array; indices: Uint16Array } {
  const t = (1 + Math.sqrt(5)) / 2
  const points: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map(([x = 0, y = 0, z = 0]) => {
    const length = Math.hypot(x, y, z)
    return [x / length, y / length, z / length]
  })
  let faces = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ]
  for (let level = 0; level < subdivisions; level++) {
    const cache = new Map<string, number>()
    const midpoint = (a: number, b: number) => {
      const key = a < b ? `${String(a)}:${String(b)}` : `${String(b)}:${String(a)}`
      const known = cache.get(key)
      if (known !== undefined) return known
      const pa = points[a] ?? [0, 0, 0]
      const pb = points[b] ?? [0, 0, 0]
      const m = [(pa[0]! + pb[0]!) / 2, (pa[1]! + pb[1]!) / 2, (pa[2]! + pb[2]!) / 2]
      const length = Math.hypot(m[0]!, m[1]!, m[2]!)
      points.push([m[0]! / length, m[1]! / length, m[2]! / length])
      cache.set(key, points.length - 1)
      return points.length - 1
    }
    faces = faces.flatMap(([a = 0, b = 0, c = 0]) => {
      const ab = midpoint(a, b)
      const bc = midpoint(b, c)
      const ca = midpoint(c, a)
      return [
        [a, ab, ca],
        [b, bc, ab],
        [c, ca, bc],
        [ab, bc, ca],
      ]
    })
  }
  return { positions: new Float32Array(points.flat()), indices: new Uint16Array(faces.flat()) }
}
