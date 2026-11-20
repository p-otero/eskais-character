// The scan worker is loaded by URL (`new Worker(new URL("eskais-character/worker", import.meta.url))`), never
// imported for values; this declaration only tells type checkers the subpath exists.
export type ScanWorkerScript = never
