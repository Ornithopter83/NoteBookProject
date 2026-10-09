export interface AiPathSegment {
  op: 'M' | 'L' | 'C' | 'Z'
  points: number[][]
}

export interface AiPathItem {
  type: 'path'
  segments: AiPathSegment[]
  paint: 'S' | 's' | 'f' | 'F' | 'f*' | 'B' | 'B*' | 'b' | 'b*'
}

export interface AiTextItem {
  type: 'text'
  text: string
  position: [number, number]
  fontSize: number
}

export type AiPageItem = AiPathItem | AiTextItem

export interface AiPage {
  width: number
  height: number
  items: AiPageItem[]
}

export interface AiDocument {
  format: 'pdf-compatible-ai-subset'
  pdfVersion: string
  pages: AiPage[]
}

export interface PdfSubsetDocument {
  format: 'pdf-vector-text-subset'
  pdfVersion: string
  pages: AiPage[]
}

export interface AiInspection {
  status: 'pdf-compatible-ai' | 'pdf-without-ai-marker' | 'unsupported' | 'invalid'
  compatible: boolean
  /** Always unverified unless an Illustrator-generated fixture is independently documented and tested. */
  adobeCompatibility: 'unverified'
  pdfVersion?: string
  pages?: number
  supportedFeatures?: string[]
  warnings?: string[]
  reason?: string
  code?: string
}

export class AiBridgeError extends Error {
  code: string
}

export function inspectAi(input: Uint8Array): AiInspection
export function analyzeAi(input: Uint8Array): AiDocument
export function analyzePdfSubset(input: Uint8Array): PdfSubsetDocument
export function transformDocument(document: AiDocument, matrix: number[]): AiDocument
export function writePdf(document: AiDocument): Uint8Array
