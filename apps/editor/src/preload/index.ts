import { contextBridge, ipcRenderer } from 'electron'
import type { EditorDocument } from '../shared/document'

contextBridge.exposeInMainWorld('northstar', {
  openDocument: (): Promise<{ filePath: string; document: EditorDocument } | null> => ipcRenderer.invoke('document:open'),
  saveDocument: (document: EditorDocument): Promise<{ filePath: string; document: EditorDocument } | null> => ipcRenderer.invoke('document:save', { document }),
  importImage: (): Promise<string | null> => ipcRenderer.invoke('image:import')
})
