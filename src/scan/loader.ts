// The only module allowed to touch the network (lint: character/no-network-outside-loader). It fetches pinned assets
// and verifies their SHA-256 before anything uses them; it never sends data, only GETs.

import { pinnedAssets, type AssetId } from "./assets.ts"

export class AssetLoadError extends Error {
  override name = "AssetLoadError"
}

export class AssetIntegrityError extends Error {
  override name = "AssetIntegrityError"
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export type AssetUrls = Partial<Record<AssetId, string>>

/**
 * Whether this code runs in a classic worker. Bundlers differ: Vite and webpack start `new Worker(…, { type: "module" })`
 * as a module worker, Next's Turbopack as a classic one that loads chunks with importScripts. MediaPipe ships a loader
 * for each. A module worker throws on importScripts, even with no arguments; a classic one does nothing.
 */
export function isClassicWorker(): boolean {
  const scope = globalThis as { importScripts?: (...urls: string[]) => void }
  if (typeof scope.importScripts !== "function") return false
  try {
    scope.importScripts()
    return true
  } catch {
    return false
  }
}

/**
 * Fetches a pinned asset from the host's copy when there is one, else from its pinned URL; when the host's copy can't
 * be loaded at all (a bundler that didn't emit it), from the pinned URL. Either way the bytes must match the pin.
 */
export async function fetchPinned(id: AssetId, urls: AssetUrls, signal?: AbortSignal): Promise<ArrayBuffer> {
  const pinned = pinnedAssets[id]
  const own = urls[id]
  if (own && own !== pinned.url)
    try {
      return await fetchFrom(id, own, signal)
    } catch (error) {
      if (!(error instanceof AssetLoadError)) throw error
    }
  return fetchFrom(id, pinned.url, signal)
}

async function fetchFrom(id: AssetId, url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const pinned = pinnedAssets[id]
  let response: Response
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "force-cache",
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new AssetLoadError(`Could not load ${id}: the request failed.`)
  }
  if (!response.ok) throw new AssetLoadError(`Could not load ${id} (${String(response.status)}).`)
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
