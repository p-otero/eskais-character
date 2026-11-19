// The only module allowed to touch the network (lint: character/no-network-outside-loader). It fetches pinned assets
// and verifies their SHA-256 before anything uses them; it never sends data, only GETs.

import { pinnedAssets, type AssetId } from "./assets.ts"

export class AssetIntegrityError extends Error {
  override name = "AssetIntegrityError"
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export type AssetUrls = Partial<Record<AssetId, string>>

export async function fetchPinned(id: AssetId, urls: AssetUrls, signal?: AbortSignal): Promise<ArrayBuffer> {
  const pinned = pinnedAssets[id]
  const url = urls[id] ?? pinned.url
  const response = await fetch(url, {
    method: "GET",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "force-cache",
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw new Error(`Could not load ${id} (${String(response.status)}).`)
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength !== pinned.bytes)
    throw new AssetIntegrityError(`${id} is ${String(bytes.byteLength)} bytes; the pin says ${String(pinned.bytes)}.`)
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes))
  if (digest !== pinned.sha256) throw new AssetIntegrityError(`${id} does not match its pinned SHA-256.`)
  return bytes
}

/** A verified asset as a same-origin blob URL, for MediaPipe's loader, which wants URLs. */
export async function pinnedBlobUrl(id: AssetId, urls: AssetUrls, type: string, signal?: AbortSignal): Promise<string> {
  const bytes = await fetchPinned(id, urls, signal)
  return URL.createObjectURL(new Blob([bytes], { type }))
}
