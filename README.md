# Threatback

Follow your thoughts. Find your way back.

Threatback is an Obsidian plugin that shows the route you followed through your notes and optional breadcrumb paths inferred from their links. It works above the note in Live Preview, Source mode, and Reading view, without changing your Markdown.

## Features

- **Navigation trail:** a clickable route for each tab. Following a note link continues the trail; opening another note through search, the quick switcher, or the file explorer starts a new one. Revisiting an earlier note trims the route back to it.
- **Inferred paths:** discover possible ancestors through incoming links, with support for multiple parents and independent starting notes.
- **Local heuristics:** optionally use surrounding text and list placement to distinguish likely parents from ordinary references.
- **Graph ranking:** independently penalize reciprocal links and detours, and favor likely overview notes.
- **Compact display:** one inferred path initially, with more available on demand. Long navigation trails scroll horizontally.
- **Folder exclusions and depth limits:** choose which folders participate and how far inferred paths extend.

## Install

1. Download the three files in `release/`: `main.js`, `manifest.json`, and `styles.css`.
2. Create `<vault>/.obsidian/plugins/threatback/` and put those files inside it.
3. Restart Obsidian and enable **Threatback** under **Settings → Community plugins**.

Requires Obsidian 1.8.7 or later.


## Settings

| Setting | Effect |
| --- | --- |
| Show navigation trail | Show the links followed in the current tab. Turning this off clears the history. |
| Show inferred paths | Show routes calculated from note links. Turning this off pauses link analysis. |
| Use local heuristics | Infer likely parents from link context. Turn off to follow all eligible incoming links. |
| Penalize reciprocal links | Rank routes with two-way links lower. |
| Penalize detours | Prefer direct routes over longer routes with shortcuts. |
| Rank likely overview notes | Favor starting notes with broad outward links. |
| Maximum ancestor depth | Follow 1–20 ancestor links; defaults to 5. |
| Excluded folders | Ignore listed vault-relative folders and their subfolders. |

For **trail-only mode**, enable Show navigation trail and disable Show inferred paths. For unfiltered incoming-link traversal, disable local heuristics and all three ranking options. Depth, exclusions, and safety limits still apply.

## Limits

Navigation history stays in memory, holds up to 50 notes per tab, and clears on restart, plugin reload, or disabling the trail.

Inferred paths are suggestions, not a guaranteed hierarchy. Context heuristics recognize English phrases; graph ranking uses link structure. Ambiguous links may produce missing or incorrect paths. Inferred navigation is bounded to 100 paths and 5,000 search states per displayed note. An ellipsis marks a suggested starting point or a cycle/depth boundary; hover for details.

Link detection supports standard internal links and breadcrumb clicks. Unsupported link renderers, ambiguous aliases, delayed navigation, and some keyboard actions may reset the trail rather than extend it. Inline embeds, Canvas, and hover previews do not receive separate breadcrumb panels.

## Build

Requires Node.js 20+ and pnpm 11+.

```sh
pnpm install --frozen-lockfile
pnpm run build
```

The build checks TypeScript and writes the three installable files into `release/`. Publish those three files as GitHub release assets. Development dependencies are excluded from Git.

## License

[MIT](LICENSE)

## Release automation

Push a version tag matching `manifest.json` and `package.json` (for example `0.7.0`, without `v`) after committing the rebuilt `release/` files. The GitHub Actions release workflow installs locked dependencies, rebuilds, verifies the committed assets match, generates GitHub artifact attestations for all three assets, and publishes the release. Do not create the same release manually before the workflow runs.

```sh
git tag 0.7.0
git push origin 0.7.0
```

After the workflow succeeds, provenance can be verified with:

```sh
gh attestation verify release/main.js --repo dariusbarbus/threatback
gh attestation verify release/styles.css --repo dariusbarbus/threatback
```

Attestations are created by GitHub Actions, not by a local build. Settings are searchable on Obsidian 1.13.0 or later; earlier supported versions retain the standard settings screen.
