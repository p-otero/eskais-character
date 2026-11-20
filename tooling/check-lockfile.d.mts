export interface BunLock {
  workspaces?: Record<string, Record<string, Record<string, string>>>
  packages?: Record<string, unknown[]>
}
export declare function parseBunLock(text: string): BunLock
export declare function lockfileProblems(
  pkg: Record<string, Record<string, string> | undefined>,
  lock: BunLock,
  installedVersion: (name: string) => string | undefined,
): string[]
