# Northstar Editor

Electron, React, TypeScript, and Vite based desktop canvas editor.

## Development

Use Node.js 22.6 or newer, then run these commands from `apps/editor`:

```sh
npm install
npm run dev
```

## Build and checks

```sh
npm run build
npm run typecheck
npm test
```

The production build is written to `out/`. The app can be started in development with `npm run dev`.

## Canvas and documents

- Add rectangles, ellipses, text, and raster images from the left toolbar.
- Select and drag canvas objects; edit position, size, rotation, fill, and opacity in the properties panel.
- Change visibility, lock state, and stacking order from the layer panel.
- Undo and redo with the toolbar or `Ctrl+Z` / `Ctrl+Shift+Z`; save with `Ctrl+S`.
- `.nbdoc` files are UTF-8 JSON. Imported images are stored beside the document in a `<document>.assets/` folder and referenced with relative paths.

## Windows GUI smoke

Run `npm run dev` on Windows and verify: add and move a rectangle; change its fill and dimensions; hide and reorder it in Layers; undo and redo; save as `.nbdoc`; close and reopen it; and confirm that the shape and imported image remain visible. The editor window uses a sandboxed renderer and exposes only document and image dialog operations through the preload bridge.
