declare module '@northstar/ai-bridge' {
  export interface AiPathSegment { op: 'M' | 'L' | 'C' | 'Z'; points: number[][] }
  export interface AiPathItem { type: 'path'; segments: AiPathSegment[]; paint: 'S' | 's' | 'f' | 'F' | 'f*' | 'B' | 'B*' | 'b' | 'b*' }
  export interface AiTextItem { type: 'text'; text: string; position: [number, number]; fontSize: number }
  export interface AiDocument { format: 'pdf-compatible-ai-subset'; pdfVersion: string; pages: Array<{ width: number; height: number; items: Array<AiPathItem | AiTextItem> }> }
  export function inspectAi(input: Uint8Array): { status: string; compatible: boolean; pages?: number; reason?: string }
  export function analyzeAi(input: Uint8Array): AiDocument
}
