# ProtoCode Build Plan

## Context

The Code Pad Wide Portable (`scripts/create/portable/create-code-pad-wide-portable.js`) is a browser-piloted code editor inside Resonite. The browser runs an embedded JavaScript runtime that handles editing logic and renders via `sendToResonite(tag + '¶' + value)` through a proxy WebSocket relay to ProtoFlux data receivers in-world.

**ProtoCode** replaces the browser runtime with a **VSCode extension** that:
- Displays VSCode workspace files on the existing Resonite Code Pad Wide screen
- Accepts VR input (keystrokes, pointer, controller) and applies edits to VSCode documents
- Embeds its own lightweight WebSocket server for bidirectional communication with Resonite
- Requires NO ResoniteLink connection — all communication flows through the proxy WebSocket

The Resonite scene (screen display + ~100 ProtoFlux data receivers) is **pre-built** using the existing browser creation script. The extension only handles runtime rendering and input.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  VSCode Extension Host (Node.js)                                  │
│                                                                   │
│  ┌─────────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ FileManager      │  │ RenderEngine │  │ InputHandler         │ │
│  │ - TextDocument   │→ │ - 18 lines   │  │ - keystroke→edit     │ │
│  │ - cursor/select  │  │ - dirty cache│  │ - pointer→cursor     │ │
│  │ - VSCode events  │  │ - highlight  │  │ - scroll/controller  │ │
│  └────────┬─────────┘  └──────┬───────┘  └───────┬──────────────┘ │
│           │                   │                   │                │
│  ┌────────┴───────────────────┴───────────────────┴──────────────┐ │
│  │ EmbeddedProxy (WebSocket server on configurable port)         │ │
│  │ - Resonite NetLink connects as WS client                      │ │
│  │ - Outgoing: send("tag¶value") → Resonite                     │ │
│  │ - Incoming: parse Resonite strings → dispatch to InputHandler │ │
│  └───────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
                              │ WebSocket
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Resonite World                                                  │
│  NetLink WebsocketConnect → ws://host-ip:PORT                    │
│                                                                  │
│  Incoming messages (from extension):                             │
│    "cpw_c3¶<color=#c678dd>const</color> x = 5"                 │
│    → DynamicImpulseReceiver tag='cpw_c3'                        │
│    → Data receiver writes to TextRenderer[3].Text               │
│                                                                  │
│  Outgoing messages (to extension):                               │
│    "keyStroke:ProtoCode:a"                                       │
│    "appEvent:ProtoCode:triggerDown¶0.5,0.3"                     │
│    → NetLink WebsocketTextMessageSender                          │
└──────────────────────────────────────────────────────────────────┘
```

**Key simplification:** No ResoniteLink connection. The extension is purely a WebSocket server that sends display data and receives input — identical to the role the browser's embedded ScriptRunner plays today, but sourcing content from VSCode documents.

---

## File Structure

```
playground/ProtoCode/
├── package.json                     # VSCode extension manifest
├── tsconfig.json
├── src/
│   ├── extension.ts                 # Activation, commands, lifecycle
│   ├── proxy/
│   │   └── embedded-proxy.ts        # Minimal WS server (Resonite connects here)
│   ├── render/
│   │   ├── render-engine.ts         # Dirty-check cache, send methods, all render functions
│   │   ├── syntax-highlighter.ts    # Regex-based JS highlighter → Resonite rich text
│   │   └── display-constants.ts     # Layout constants (RENDER_W=1200, LINE_H=40, etc.)
│   ├── editor/
│   │   ├── file-manager.ts          # VSCode event listeners (document, cursor, scroll)
│   │   ├── input-handler.ts         # Parse Resonite strings → structured events
│   │   └── edit-bridge.ts           # Apply VR edits to VSCode TextDocument
│   └── ui/
│       └── status-bar.ts            # Connection state, file name indicator
```

---

## Protocol: Extension ↔ Resonite

### Outgoing (Extension → Resonite via WebSocket)

The extension sends raw strings in the format `tag¶value` directly to all connected Resonite clients. No relay prefix needed — the extension IS the server.

**Tag map (matches existing Code Pad Wide data receivers):**

| Tags | Type | Count | Purpose |
|------|------|-------|---------|
| `cpw_c0`..`cpw_c17` | string | 18 | Code line text (with rich text color tags) |
| `cpw_n0`..`cpw_n17` | string | 18 | Line number text |
| `cpw_s` | string | 1 | Status bar text |
| `cpw_co` | string | 1 | Full content output (DVV) |
| `cpw_cp` | float3 | 1 | Cursor position `[x; y; z]` |
| `cpw_lh` | float3 | 1 | Line highlight position |
| `cpw_tp` | float3 | 1 | Scroll thumb position |
| `cpw_ca` | bool | 1 | Cursor active (True/False) |
| `cpw_ta` | bool | 1 | Scroll thumb active |
| `cpw_sqp0`..`cpw_sqp17` | float3 | 18 | Selection quad positions |
| `cpw_sqa0`..`cpw_sqa17` | bool | 18 | Selection quad active |
| `cpw_sqs0`..`cpw_sqs17` | float2 | 18 | Selection quad sizes `[w; h]` |
| `cpw_ts` | float2 | 1 | Scroll thumb size |

### Incoming (Resonite → Extension via WebSocket)

Resonite sends raw strings. The InputHandler parses these formats:

| Format | Example | Parsed |
|--------|---------|--------|
| `keyStroke:AppName:key` | `keyStroke:ProtoCode:a` | `{ type: 'keystroke', key: 'a' }` |
| `appEvent:AppName:event¶x,y` | `appEvent:ProtoCode:triggerDown¶0.5,0.3` | `{ type: 'triggerDown', x: 0.5, y: 0.3 }` |
| `controllerInput:App:event:data` | `controllerInput:ProtoCode:thumbstickAxis:[0;-0.5]` | `{ type: 'thumbstickAxis', x: 0, y: -0.5 }` |
| `setActiveUser:User:Id` | `setActiveUser:Player1:KB_123` | `{ type: 'activeUser', username: 'Player1' }` |

---

## Data Flow

### VSCode → Resonite (Rendering)

```
1. User types/moves cursor/scrolls in VSCode
2. VSCode event fires (onDidChangeTextDocument / onDidChangeTextEditorSelection / etc.)
3. FileManager notifies RenderEngine
4. RenderEngine reads document.lineAt(i).text for visible lines
5. SyntaxHighlighter converts to Resonite rich text: <color=#c678dd>const</color>
6. Dirty-check: skip send if displayedCode[i] === highlighted
7. EmbeddedProxy sends to all Resonite clients: "cpw_c3¶<color=#c678dd>const</color> x"
8. Resonite NetLink receives → DynamicImpulse tag='cpw_c3' → data receiver writes text
```

### Resonite → VSCode (Input)

```
1. VR user presses key / clicks screen / moves thumbstick
2. Resonite ProtoFlux fires WebsocketTextMessageSender: "keyStroke:ProtoCode:a"
3. EmbeddedProxy receives raw string
4. InputHandler parses → { type: 'keystroke', key: 'a' }
5. EditBridge applies: vscode.commands.executeCommand('type', { text: 'a' })
6. VSCode updates document → triggers render pipeline above
```

### Pointer → Cursor Math (from embedded script)

```
pxX = (normX - 0.5) * RENDER_W          // 1200px playfield
pxY = (0.5 - normY) * RENDER_H          // 800px playfield
visLine = floor((CODE_AREA_TOP - pxY) / LINE_H)   // CODE_AREA_TOP=380, LINE_H=40
actualLine = scrollOffset + visLine
col = round((pxX - CODE_LEFT_X) / CHAR_W_APPROX)  // CHAR_W_APPROX=20
```

---

## Component Details

### EmbeddedProxy (`proxy/embedded-proxy.ts`)

Minimal WebSocket server (~100 lines) using the `ws` npm package:

- Listen on configurable port (default 3001)
- Accept connections from Resonite NetLink
- Track connected clients
- `send(tag, value)` → broadcast `tag¶value` to all clients
- `sendF3(tag, x, y, z)` → `tag¶[x; y; z]`
- `sendF2(tag, x, y)` → `tag¶[x; y]`
- `sendBool(tag, val)` → `tag¶True` or `tag¶False`
- On message received → emit event for InputHandler
- Reconnection support (Resonite may disconnect/reconnect)

### RenderEngine (`render/render-engine.ts`)

Port of the embedded script's rendering logic. Sources content from `vscode.TextDocument` instead of internal `code` string.

**State:**
- `scrollOffset: number` — first visible line index
- `displayedCode: (string|null)[18]` — dirty-check cache for code lines
- `displayedLineNum: (string|null)[18]` — dirty-check cache for line numbers
- `displayedSelQuad: (string|null)[18]` — dirty-check cache for selection quads
- `displayedStatusText: string|null` — dirty-check cache for status bar
- `cursorBlinkTimer` — 530ms interval toggle

**Methods (same names as embedded script):**
- `renderVisibleLines()` — send code lines + line numbers
- `updateCursorPosition()` — send cursor float3
- `updateLineHighlight()` — send highlight float3
- `updateSelectionQuads()` — send selection active/position/size
- `updateScrollbar()` — send thumb active/position/size
- `updateStatusBar()` — send status text
- `renderTextEdit()` — all of the above
- `renderCursorMove()` — cursor + highlight + selection + status
- `renderScroll()` — visible lines + selection + scrollbar
- `fullRender()` — invalidate cache + render everything

### SyntaxHighlighter (`render/syntax-highlighter.ts`)

Direct port of the embedded script's `highlight()` function with LRU cache:
- Keywords → `<color=#c678dd>`
- Strings → `<color=#98c379>`
- Numbers → `<color=#d19a66>`
- Comments → `<color=#5c6370>`
- Functions → `<color=#61afef>`
- `this` → `<color=#e06c75>`
- Default → `<color=#abb2bf>`
- HTML entity escaping (`&amp;`, `&lt;`)
- Cache: Map with max 3000 entries, evict 500 on overflow

### FileManager (`editor/file-manager.ts`)

Listens to VSCode events and drives the RenderEngine:

```typescript
// Document content changes → re-render affected lines
vscode.workspace.onDidChangeTextDocument → renderEngine.renderTextEdit()

// Cursor/selection changes → update cursor display
vscode.window.onDidChangeTextEditorSelection → renderEngine.renderCursorMove()

// Scroll changes → update visible lines
vscode.window.onDidChangeTextEditorVisibleRanges → renderEngine.renderScroll()

// Active editor changes → switch displayed file
vscode.window.onDidChangeActiveTextEditor → fullRender()
```

### InputHandler (`editor/input-handler.ts`)

Parses raw strings from Resonite into structured events:
- Split on `:` for message type detection
- Split on `¶` for data payload
- Dispatch to EditBridge methods

### EditBridge (`editor/edit-bridge.ts`)

Applies VR input as VSCode editor operations:

| Input | VSCode API |
|-------|-----------|
| Single char | `editor.edit(b => b.insert(pos, char))` |
| Enter | `vscode.commands.executeCommand('type', { text: '\n' })` |
| Backspace | `vscode.commands.executeCommand('deleteLeft')` |
| Delete | `vscode.commands.executeCommand('deleteRight')` |
| Arrow keys | `vscode.commands.executeCommand('cursorLeft/Right/Up/Down')` |
| Tab | `editor.edit(b => b.insert(pos, '  '))` |
| Pointer click | `editor.selection = new Selection(pos, pos)` |
| Pointer drag | `editor.selection = new Selection(anchor, active)` |
| Ctrl+A | `vscode.commands.executeCommand('editor.action.selectAll')` |
| Ctrl+Z | `vscode.commands.executeCommand('undo')` |
| Ctrl+Y | `vscode.commands.executeCommand('redo')` |

---

## Implementation Phases

### Phase 1: Extension Scaffold + Proxy
**Files:** `package.json`, `tsconfig.json`, `extension.ts`, `proxy/embedded-proxy.ts`, `ui/status-bar.ts`

1. Scaffold VSCode extension (TypeScript, `@types/vscode`, `ws` dependency)
2. Register commands: `protocode.start`, `protocode.stop`
3. Implement `EmbeddedProxy` — WS server, client tracking, send/receive
4. Implement `StatusBar` — show "ProtoCode: Listening on :3001" / "1 client connected"
5. `protocode.start` → start proxy, show status
6. `protocode.stop` → stop proxy, dispose

**Verify:** Start extension, connect Resonite NetLink to `ws://host:3001`, see "1 client connected" in status bar.

### Phase 2: Render Pipeline
**Files:** `render/render-engine.ts`, `render/syntax-highlighter.ts`, `render/display-constants.ts`

1. Port layout constants from embedded script
2. Port `highlight()` and `highlightCached()` → `SyntaxHighlighter`
3. Implement `RenderEngine` with dirty-check cache and all render methods
4. Wire `send()` to `EmbeddedProxy.send()`
5. Implement cursor blink timer (530ms setInterval)

**Verify:** Manually call `renderEngine.fullRender()` with a test document, see text appear on Resonite screen.

### Phase 3: VSCode Event Wiring
**Files:** `editor/file-manager.ts`

1. Listen to `onDidChangeTextDocument` → `renderTextEdit()`
2. Listen to `onDidChangeTextEditorSelection` → `renderCursorMove()`
3. Listen to `onDidChangeTextEditorVisibleRanges` → `renderScroll()`
4. Listen to `onDidChangeActiveTextEditor` → switch file, `fullRender()`
5. Implement render throttle (requestAnimationFrame-style debounce, ~30fps cap)

**Verify:** Open a file in VSCode, see it on Resonite screen. Type → see updates. Move cursor → see cursor move. Scroll → see lines change.

### Phase 4: Bidirectional Input
**Files:** `editor/input-handler.ts`, `editor/edit-bridge.ts`

1. Implement `InputHandler` message parser for all Resonite string formats
2. Implement `EditBridge` with VSCode command execution
3. Wire proxy incoming messages → InputHandler → EditBridge
4. Handle pointer-based cursor positioning (normalized coords → line/col)
5. Handle selection drag (track anchor point, update on pointerMove)
6. Handle scrollbar drag
7. Debounce to prevent render loops (skip render trigger for edits from Resonite)

**Verify:** Press virtual keyboard in Resonite → chars appear in VSCode. Click on screen → cursor moves in VSCode. Type in VSCode → see on Resonite screen.

### Phase 5: Polish
1. Configuration: port, render FPS, enable/disable syntax highlighting
2. Multi-file: active editor switch updates display, file name in status bar
3. Error handling: proxy restart, client disconnect/reconnect
4. Language detection: use `document.languageId` to enable/disable JS highlighting
5. Extension packaging

---

## Critical Source Reference

| File | Lines | What to Port |
|------|-------|-------------|
| `create-code-pad-wide-portable.js` | 547-603 | Layout constants, send helpers |
| Same | 605-743 | Syntax highlighter (highlight, highlightCached, escHtml) |
| Same | 805-982 | All render functions (renderVisibleLines, updateCursorPosition, etc.) |
| Same | 1122-1349 | Keystroke handler (key mapping, cursor movement, text editing) |
| Same | 1351-1501 | Pointer/controller handlers (triggerDown, pointerMove, thumbstick) |
| `services/proxy/server.js` | 788-932 | Message parsing formats (reference only) |

---

## Verification Plan

1. **Phase 1:** Start proxy → connect Resonite NetLink → verify WebSocket handshake
2. **Phase 2:** Call `fullRender()` manually → verify all 18 code lines appear with highlighting
3. **Phase 3:** Type in VSCode → verify <100ms latency to Resonite display update
4. **Phase 4:** Press VR keyboard → verify char appears in VSCode within 1 frame
5. **End-to-end:** Two-person test — one in VSCode, one in VR, both editing simultaneously
