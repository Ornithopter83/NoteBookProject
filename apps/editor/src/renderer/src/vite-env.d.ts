/// <reference types="vite/client" />
import type { EditorDocument } from '../../shared/document'
import type { PsdEditorDocument } from '../../preload'
import type { LayerChanges } from '@northstar/psd-bridge'

declare global {
  interface Window {
    northstar: {
      openDocument(): Promise<{ filePath: string; document?: EditorDocument; psd?: PsdEditorDocument; aiImport?: { pdfVersion: string; sourceName: string; limitations: string } } | null>
      saveDocument(document: EditorDocument): Promise<{ filePath: string; document: EditorDocument } | null>
      importImage(): Promise<string | null>
      savePsd(sessionId: string, edits: Array<{ id: string; changes: LayerChanges }>): Promise<{ filePath: string } | null>
      exportFile(payload: { format: 'png' | 'jpeg' | 'svg' | 'pdf' | 'psd'; width: number; height: number; svg?: string; pixels?: Uint8Array; image?: Uint8Array; name: string }): Promise<{ filePath: string } | null>
    }
  }
}
