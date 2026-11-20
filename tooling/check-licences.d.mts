export declare const allowedLicences: Set<string>
export declare const allowedDataLicences: Set<string>
export declare const licenceExceptions: Record<string, string>
export declare const forbiddenName: RegExp
export declare const forbiddenExceptions: Record<string, string>
export declare function licenceAllowed(expression: string, allowed?: Set<string>): boolean
export declare function checkLicences(): { problems: string[]; packageCount: number; exceptions: string[] }
