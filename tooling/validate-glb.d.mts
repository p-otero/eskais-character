export interface GltfIssue {
  code: string
  message: string
  severity: number
  pointer?: string
}
export declare function validateGlb(
  bytes: Uint8Array,
  uri?: string,
): Promise<{ report: unknown; errors: GltfIssue[]; warnings: GltfIssue[] }>
