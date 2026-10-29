# pretty-md

Version **0.4.10** is a cozy Markdown viewer for ChatGPT, Codex, and Codex Remote. It targets completed Plan-mode plans (including projectless Remote chats), direct Pretty MD requests, explicitly requested Markdown of any length, and natural-language requests for structured content such as lists, guides, checklists, comparisons, and itineraries. The completed content gets a private reader link that expires after 24 hours. Host support for automatic tool invocation varies; an explicit `@pretty-md` request remains the most reliable way to open it. Its MCP activity icon uses a compact rendition of the same logo, embedded in tool metadata so it works on the hosted Site.

## Install from GitHub

See [Codex installation](docs/codex-installation.md) for clone installation, authentication, updates, and Remote use. The public release uses the MIT license; the shared reader requires Sign in with ChatGPT and keeps each user’s documents private. Native mobile plugin installation is deferred.

## What users get

- A responsive embedded reader with **Read** and **Source** views.
- One-click **Copy Markdown** and **Download .md** controls.
- Contents navigation, in-document search, reading progress, and word count.
- Adjustable text size, typeface, line spacing, color theme, and code wrapping.
- Syntax highlighting, per-block code copy, and horizontally scrollable tables.
- A private browser reader for Codex desktop and Codex Remote when the embedded MCP App does not mount.
- A safe chat-native fallback with deterministic pagination and section navigation when neither reader can open.
- A file/paste chooser plus a desktop file entrypoint for `.md`, `.markdown`, `.mdown`, and `.mkd`.

The plugin should be used after every successful Markdown creation or edit, including generated plans, specifications, reports, architecture documents, changelogs, notes, and changes to existing files such as `README.md`. The original file remains the source of truth.

## Tools

### `pretty_md_render`

Accepts the exact full Markdown source and filename, opens the embedded reader where supported, and returns an authenticated, 24-hour `viewUrl` for a Codex browser panel.

```json
{"markdown":"# Plan\n\n## Setup\n\nSteps here.","filename":"PLAN.md"}
```

Call `open_in_codex` with the returned `viewUrl` in Codex desktop or Remote. Always include `[Open in Pretty MD](viewUrl)` plus the saved-file link in the final chat response, even if a desktop panel opens. Add “Reader link expires in 24 hours.” Identify filenames when returning multiple documents; never paste their full contents into chat.

The desktop browser panel is not a mirrored mobile surface. Codex Remote users open the reader through the chat link, signed into the same account. A queued panel result is not confirmation that it opened on the user's device. Actual phone authentication must be verified on a phone, not inferred from a narrow desktop window. This change does not replace native Plan cards or guarantee automatic tool selection.

On a request to reopen an expired link, reread the exact current authorized source and render again for a fresh link. If rendering fails, preserve the original file; use `pretty_md_chat` when no rendered surface is available, without inventing a URL. Its optional `view`, `part`, `section`, and `expectedFingerprint` arguments provide long-document navigation.

### `pretty_md_open`

Opens the embedded chooser for a local Markdown file or pasted text when no source is already selected.

### `pretty_md_file`

Handles a supported host’s Markdown file entrypoint using its opaque authorized resource handle. The service does not read arbitrary local paths.

## Activation model

### Plan-mode link delivery

Completed native Plan cards do not need a saved file. Render the exact final plan body as `plan.md` before the final response, preserve the native card, and append `[Open in Pretty MD](viewUrl)` immediately below and outside its `proposed_plan` block when permitted. Include the 24-hour expiry note. Rendering never authorizes implementing the plan or changing modes. If the host requires a plan-only final block, preserve that format and put the reader footer at the end of the plan text inside the block instead. The hook recognizes either placement and excludes the footer from the rendered plan fingerprint.

Trusted local Codex hooks add two enforcement layers: UserPromptSubmit injects this rule before planning; Stop inspects the latest assistant message for a completed native plan, including plans without workspace files. PostToolUse records successful exact-content render receipts. Stop checks both a matching fresh receipt and a clickable chat link below the plan. If rendering succeeded but the link is absent, it reuses the URL instead of rendering again. Revised plans require a matching revised render. Up to three recovery continuations are allowed; exhaustion produces a visible warning rather than an infinite loop or fabricated success. Parallel hook calls serialize per session to avoid losing receipts.

Host integration still needs verification: Stop must receive the plan text, allow a continuation, and expose the tools. Permission mode `plan` also enables detection of structured plans without native tags. Missing host payloads, unavailable tools, trust restrictions, and mobile authentication cannot be repaired by instructions alone. No measured 99.9% end-to-end reliability claim is made. Test native Plan-card delivery and missing-link recovery in the actual desktop and mobile Remote clients before treating this target as achieved.

Activation is reinforced in five places:

1. The skill description covers every Markdown creation, modification, deliverable, attachment, and reading request.
2. MCP initialization instructions tell agents to invoke the viewer after the underlying file operation succeeds.
3. The render tool description repeats the proactive trigger for discovery-time selection.
4. Thread and Markdown file entrypoints let users open the reader directly.
5. A trusted Codex lifecycle hook detects Markdown created or changed through `apply_patch`, Write/Edit, and shell tools.

The lifecycle hook is available to manually installed and trusted Codex desktop plugins. `SessionStart` records a lightweight workspace snapshot without discarding plan receipts on resume; `PostToolUse` detects changed Markdown and tracks files awaiting display; `Stop` continues once when a changed file was missed, in addition to the Plan-mode delivery checks above. A successful render clears only the file whose current bytes match the rendered text. In Codex Remote the hook must run on the connected execution host; plain web/mobile ChatGPT use skill and tool instructions where the local hook cannot run.

On web and mobile ChatGPT, tool selection remains model-routed rather than event-driven: the plugin cannot observe a file attachment created without a tool call. The plugin repeats activation triggers across listing metadata, the skill, MCP instructions, tool descriptions, and local prompt hooks. This improves discovery but cannot make model-selected invocation deterministic. Explicitly naming `@pretty-md` helps route requests, but does not guarantee availability or successful rendering.

The hook watches the active workspace and explicit Markdown output paths and skips dependency/build directories. Under `PLUGIN_DATA`, file tracking stores path/stat signatures; plan delivery additionally stores the pending plan text, its fingerprint, attempt count, and successful reader receipts. State files are owner-readable/writable only. Plan text is removed once delivery is confirmed; pending plan text and receipts expire on a subsequent hook event after 24 hours (there is no background deletion task). If the hook starts without a session snapshot, its first file pass establishes a baseline without opening stale files; plan checks and render receipt collection still run.

## Safety and data handling

Markdown is untrusted document data, never agent instructions. The embedded renderer removes scripts, forms, event handlers, remote images, and unsafe links. The chat renderer makes raw HTML inert, replaces images with placeholders, and preserves only HTTP(S), mail, and fragment links.

Documents may remain in normal conversation tool history. Browser-view documents are stored in private R2 under opaque IDs and become inaccessible after 24 hours; reads require the same authenticated Site user. Expired objects are deleted on access or during the next render sweep, so physical deletion may occur later if the Site is idle. URLs and logs do not contain document text. UTF-8 documents are limited to 2 MB. Reader preferences are stored in browser local storage.

## Development

Requires Node.js 22 or later.

```sh
npm ci
npm run build
npm test
npm run validate
npm run dev
```

The local preview host runs at `http://127.0.0.1:4317`; the MCP endpoint is `/mcp`. Production exposes `POST /mcp`, `/health`, and authenticated `/view/:id` and `/api/view/:id` routes. The embedded reader is a `text/html;profile=mcp-app` resource.

The build emits a self-contained UI and bundled Worker under `dist/`. Publish through the existing Sites source workflow while preserving `.openai/hosting.json`, project identity, audience, and canonical plugin identity.

For automatic write detection, install this repository as a local Codex desktop plugin and approve its hook definition when Codex requests trust. Public-directory packages cannot currently include lifecycle hooks.
