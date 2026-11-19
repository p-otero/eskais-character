declare module "gltf-validator" {
  interface ValidationMessage {
    code: string
    message: string
    severity: number
    pointer?: string
  }
  interface ValidationReport {
    issues: {
      numErrors: number
      numWarnings: number
      numInfos: number
      numHints: number
      messages: ValidationMessage[]
    }
  }
  export function validateBytes(
    data: Uint8Array,
    options?: { maxIssues?: number; uri?: string },
  ): Promise<ValidationReport>
}
