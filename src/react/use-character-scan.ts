import { useCallback, useEffect, useReducer, useRef } from "react"
import type { ScanEngine } from "../scan/engine.ts"
import { ScanError } from "../scan/errors.ts"
import type { Character, RestyleOptions, ScanEvent, ScanInput, ScanOptions, ScanStage } from "../scan/types.ts"

/** A person mask: confidence 0–255, row-major. */
export interface ScanMask {
  width: number
  height: number
  data: Uint8Array
}

export type ScanStatus = "idle" | "scanning" | "done" | "error" | "cancelled"

/** Props-shaped scan state for ModelScan / ModelViewer. */
export interface CharacterScanState {
  status: ScanStatus
  stage: ScanStage | null
  /** 0..1. */
  progress: number
  landmarks: { face: Float32Array | null; body: Float32Array | null }
  /** Person masks for the photo-to-character transition (see the `mask` event). */
  masks: { face: ScanMask | null; body: ScanMask | null }
  /** The base GLB to load once; morph it by setting `weights`. */
  model: { glb: Uint8Array; targetNames: string[] } | null
  weights: Float32Array | null
  character: Character | null
  error: Error | null
}

export const initialScanState: CharacterScanState = {
  status: "idle",
  stage: null,
  progress: 0,
  landmarks: { face: null, body: null },
  masks: { face: null, body: null },
  model: null,
  weights: null,
  character: null,
  error: null,
}

type Action =
  | { type: "start" }
  | { type: "restyled"; character: Character }
  | { type: "event"; event: ScanEvent }
  | { type: "error"; error: Error }
  | { type: "cancelled" }

/** Pure: how one scan event changes the state. Exported for tests and for hosts that don't use React. */
export function reduceScan(state: CharacterScanState, action: Action): CharacterScanState {
  switch (action.type) {
    case "start":
      return { ...initialScanState, status: "scanning" }
    case "restyled":
      return { ...state, character: action.character, weights: action.character.weights }
    case "error":
      return { ...state, status: "error", error: action.error }
    case "cancelled":
      return { ...state, status: "cancelled" }
    case "event": {
      const { event } = action
      switch (event.type) {
        case "stage":
          return event.ms === undefined ? { ...state, stage: event.stage } : state
        case "mask":
          return {
            ...state,
            masks: { ...state.masks, [event.source]: { width: event.width, height: event.height, data: event.data } },
          }
        case "landmarks":
          return { ...state, landmarks: { ...state.landmarks, [event.source]: event.points } }
        case "model":
          return { ...state, model: { glb: event.glb, targetNames: event.targetNames } }
        case "progress":
          return { ...state, progress: event.value, weights: event.weights }
        case "error":
          return { ...state, status: "error", stage: null, error: new ScanError(event.error.code, event.error.message) }
        case "done":
          return {
            ...state,
            status: "done",
            stage: null,
            progress: 1,
            character: event.character,
            weights: event.character.weights,
          }
      }
    }
  }
  return state
}

export interface CharacterScan extends CharacterScanState {
  start(input: ScanInput, options?: Omit<ScanOptions, "signal">): Promise<void>
  /** Re-exports the finished character with another look, hair or colours; no-op before a character exists. */
  restyle(options: RestyleOptions): Promise<void>
  cancel(): void
}

export function useCharacterScan(engine: ScanEngine): CharacterScan {
  const [state, dispatch] = useReducer(reduceScan, initialScanState)
  const controller = useRef<AbortController | null>(null)

  const cancel = useCallback(() => {
    controller.current?.abort()
    controller.current = null
  }, [])

  // Not memoised: it reads `engine` at call time, and hosts call it from event handlers.
  const start = async (input: ScanInput, options: Omit<ScanOptions, "signal"> = {}) => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    dispatch({ type: "start" })
    try {
      for await (const event of engine.scan(input, { ...options, signal: current.signal }))
        dispatch({ type: "event", event })
    } catch (error) {
      if (current.signal.aborted) dispatch({ type: "cancelled" })
      else dispatch({ type: "error", error: error instanceof Error ? error : new Error("The scan failed.") })
    } finally {
      if (controller.current === current) controller.current = null
    }
  }

  // A scan still running when the component unmounts is abandoned, so its worker stops sending events.
  useEffect(() => cancel, [cancel])

  const restyle = async (options: RestyleOptions) => {
    if (!state.character) return
    try {
      dispatch({ type: "restyled", character: await engine.restyle(state.character, options) })
    } catch (error) {
      dispatch({ type: "error", error: error instanceof Error ? error : new Error("Restyling failed.") })
    }
  }

  return { ...state, start, cancel, restyle }
}
