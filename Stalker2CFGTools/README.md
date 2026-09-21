# STALKER 2 CFG Tools

Small VS Code extension for working with STALKER 2 `.cfg` files.

## Current MVP

- Registers `.cfg` files as `stalker2-cfg`
- Indexes CFG symbol definitions such as:
  - `GunAK74_ST : struct.begin`
  - `SID = GunAK74_ST`
- Supports **Go to Definition** / **F12** / **Ctrl+Click** for SIDs
- Understands configurable reference folders and prioritizes definitions found there
- Prefers struct headers over duplicate `SID = ...` declarations
- Automatically re-indexes CFG files when they are created or changed
- Re-indexes when the reference path configuration changes

## Reference paths

The extension can distinguish your mod files from vanilla/reference CFGs. The default configuration is:

```json
{
  "stalker2Cfg.referencePaths": [
    "Python/VanillaReference",
    "GameLite/GameData"
  ]
}
```

Paths are relative to the opened workspace.

This is particularly useful for patches such as:

```cfg
GunM16_ST : struct.begin {bpatch}
```

If `GunM16_ST` also exists below a configured reference path, that reference definition is returned first by **Go to Definition**. VS Code can still expose additional matching definitions when more than one exists.

## Development

Requirements:

- Node.js
- npm
- VS Code

Install dependencies:

```bash
npm install
```

Compile:

```bash
npm run compile
```

Then open the `Stalker2CFGTools` folder in VS Code and press **F5** to start an Extension Development Host.

Open a STALKER 2 mod workspace in the development host and try **F12** or **Ctrl+Click** on a SID, for example:

```cfg
Gun_Drowned_AR_GS : struct.begin {refkey=GunAK74_ST}
```

Ctrl+Clicking `GunAK74_ST` should jump to its indexed definition.

## Next ideas

- Hover information showing definition type and source
- Find All References
- Explicit `refkey` / patch relationship information
- Syntax highlighting
- More intelligent duplicate-definition handling
- Dedicated CFG parser if regex indexing becomes too limited
