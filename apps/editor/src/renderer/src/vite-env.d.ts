/// <reference types="vite/client" />
import type { EditorDocument } from '../../shared/document'

declare global {
  interface Window {
    northstar: {
      openDocument(): Promise<{ filePath: string; document: EditorDocument } | null>
      saveDocument(document: EditorDocument): Promise<{ filePath: string; document: EditorDocument } | null>
      importImage(): Promise<string | null>
    }
  }
}
