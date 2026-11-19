import { useCallback, useEffect, useReducer, useRef } from "react"
import type { ScanEngine } from "../scan/engine.ts"
import { ScanError } from "../scan/errors.ts"
import type { Character, ScanEvent, ScanInput, ScanOptions, ScanStage } from "../scan/types.ts"

export type ScanStatus = "idle" | "scanning" | "done" | "error" | "cancelled"

/** Props-shaped scan state for ModelScan / ModelViewer. */
export interface CharacterScanState {
  status: ScanStatus
  stage: ScanStage | null
  /** 0..1. */
  progress: number
  landmarks: { face: Float32Array | null; body: Float32Array | null }
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
  model: null,
  weights: null,
  character: null,
  error: null,
}

type Action =
  | { type: "start" }
  | { type: "event"; event: ScanEvent }
  | { type: "error"; error: Error }
  | { type: "cancelled" }

/** Pure: how one scan event changes the state. Exported for tests and for hosts that don't use React. */
export function reduceScan(state: CharacterScanState, action: Action): CharacterScanState {
  switch (action.type) {
    case "start":
      return { ...initialScanState, status: "scanning" }
    case "error":
      return { ...state, status: "error", error: action.error }
    case "cancelled":
      return { ...state, status: "cancelled" }
    case "event": {
      const { event } = action
      switch (event.type) {
        case "stage":
          return event.ms === undefined ? { ...state, stage: event.stage } : state
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

  return { ...state, start, cancel }
}
