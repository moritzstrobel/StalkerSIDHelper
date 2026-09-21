# STALKER 2 CFG Tools

Small VS Code extension for working with STALKER 2 `.cfg` files.

## Current MVP

- Registers `.cfg` files as `stalker2-cfg`
- Indexes CFG symbol definitions such as:
  - `GunAK74_ST : struct.begin`
  - `SID = GunAK74_ST`
- Supports **Go to Definition** / **F12** / **Ctrl+Click** for SIDs
- Automatically re-indexes CFG files when they are created or changed

This is intentionally a small first step. A full parser or language server is not required for the initial SID navigation feature.

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

- Prefer vanilla/reference definitions when navigating from patches
- Hover information
- Find All References
- Better support for `refkey`, prototype fields and patch semantics
- Workspace/reference path configuration
- Syntax highlighting
- Dedicated CFG parser if regex indexing becomes too limited
