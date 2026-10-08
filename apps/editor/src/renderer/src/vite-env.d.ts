/// <reference types="vite/client" />
import type { EditorDocument } from '../../shared/document'
import type { PsdEditorDocument } from '../../preload'
import type { LayerChanges } from '@northstar/psd-bridge'

declare global {
  interface Window {
    northstar: {
      openDocument(): Promise<{ filePath: string; document?: EditorDocument; psd?: PsdEditorDocument } | null>
      saveDocument(document: EditorDocument): Promise<{ filePath: string; document: EditorDocument } | null>
      importImage(): Promise<string | null>
      savePsd(sessionId: string, edits: Array<{ id: string; changes: LayerChanges }>): Promise<{ filePath: string } | null>
    }
  }
}
