# ProtoCode

VSCode extension that bridges your editor to a Resonite Code Pad Wide screen via WebSocket. Edit code in VSCode, see it rendered in-world with syntax highlighting.

## Prerequisites

- VSCode 1.85+
- Node.js 18+
- A Resonite world with a Code Pad Wide (created by `create-code-pad-wide-portable.js`)

## Install & Launch (Development)

```bash
# 1. Install dependencies (first time only)
cd playground/ProtoCode
npm install

# 2. Compile TypeScript
npm run compile
#    Or watch mode for auto-recompile:
npm run watch

# 3. Open the extension folder in VSCode
code playground/ProtoCode
```

Press **F5** (or Run > Start Debugging) to launch the Extension Development Host — a second VSCode window with ProtoCode loaded.

## Start the Proxy Server

In the Extension Development Host window:

1. Open the Command Palette (`Ctrl+Shift+P`)
2. Run **"ProtoCode: Start"**
3. Status bar shows: `$(radio-tower) ProtoCode :3001`

## Connect Resonite

In-world, configure the Code Pad Wide's NetLink `WebsocketConnect` node to point to:

```
ws://<your-pc-ip>:3001
```

Once connected, the status bar updates to: `ProtoCode :3001 (1 client)`

## Monitor

- **Status bar** — shows port + connected client count at all times
- **VSCode Output panel** — extension logs appear in the "Extension Host" output channel (View > Output > select "Extension Host")
- **Breakpoints** — set breakpoints in `src/` files; they hit when running via F5

## Stop

- Command Palette > **"ProtoCode: Stop"** — stops WebSocket server, disconnects clients
- Or close the Extension Development Host window

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `protocode.wsPort` | `3001` | WebSocket server port (restarts proxy on change) |
| `protocode.resonitelinkPort` | `0` | ResoniteLink port (pings on change) |
| `protocode.renderFps` | `30` | Max render updates/sec |
| `protocode.syntaxHighlighting` | `true` | JS syntax highlighting |

Change via File > Preferences > Settings > search "protocode".

## Install as VSIX (Production)

```bash
# Install vsce if needed
npm install -g @vscode/vsce

# Package
cd playground/ProtoCode
vsce package

# Install the .vsix
code --install-extension protocode-0.1.0.vsix
```

After installing the VSIX, the commands are available in any VSCode window without F5.
