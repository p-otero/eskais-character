export declare const minimumAgeDays: number
export declare const youngDependencyExceptions: Record<string, string>
export declare function packageDependencies(pkg: Record<string, unknown>): string[]
export declare function parseDependency(spec: string): { name: string; version: string }
export declare function findYoungDependencies(
  specs: string[],
  published: Map<string, string>,
  now: number,
  options?: { minimumDays?: number; exceptions?: Record<string, string> },
): { problems: { spec: string; reason: string }[]; matured: string[] }
