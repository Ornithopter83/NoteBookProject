import { contextBridge, ipcRenderer } from 'electron'
import type { EditorDocument } from '../shared/document'
import type { LayerChanges, PsdLayerView, PsdBridgeWarning } from '@northstar/psd-bridge'

export interface PsdEditorDocument {
  sessionId: string
  name: string
  width: number
  height: number
  bitDepth: number
  layers: PsdLayerView[]
  warnings: readonly PsdBridgeWarning[]
}

contextBridge.exposeInMainWorld('northstar', {
  openDocument: (): Promise<{ filePath: string; document?: EditorDocument; psd?: PsdEditorDocument } | null> => ipcRenderer.invoke('document:open'),
  saveDocument: (document: EditorDocument): Promise<{ filePath: string; document: EditorDocument } | null> => ipcRenderer.invoke('document:save', { document }),
  importImage: (): Promise<string | null> => ipcRenderer.invoke('image:import'),
  savePsd: (sessionId: string, edits: Array<{ id: string; changes: LayerChanges }>): Promise<{ filePath: string } | null> => ipcRenderer.invoke('psd:save', { sessionId, edits })
})
