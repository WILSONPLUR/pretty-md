# Install Pretty MD

## New installation

```sh
git clone https://github.com/WILSONPLUR/pretty-md.git
cd pretty-md
codex plugin marketplace add .
codex plugin add pretty-md@pretty-md-local
```

Restart Codex. Open **Plugins → Pretty MD Local → pretty-md → Manage** and complete **Connect** when offered. Review hook trust if you want automatic plan links. Start a new chat and send:

```text
@pretty-md render a short Markdown example
```

This is one package installation. Version 0.4.12 references the existing registered ChatGPT Sites app through `.app.json`; Sites supplies the hosted tools and account connection. The skills and local hooks stay in the GitHub package.

## Already installed

```sh
cd /path/to/pretty-md
git pull --ff-only
codex plugin add pretty-md@pretty-md-local
```

Restart Codex and start a new chat. Confirm the plugin reports version **0.4.12**. Codex loads an installed cache, so pulling alone is insufficient. Do not install another Pretty MD copy.

## Hosted connection unavailable

The registered Site app must be accessible to your account. A public website does not establish public availability of its registered integration. The owner's connection is distinct from public distribution; access and rendering with an unrelated account still need verification. If access is denied, report that error rather than repeatedly cloning or installing. The public release of the existing integration remains a publisher task.

Version 0.4.10 incorrectly configured the Site as a standalone raw MCP URL. Its login failed with `Dynamic client registration not supported`; CIMD was also rejected. Version 0.4.12 removes that raw connection. Do not run `codex mcp login pretty-md` for this package.

If a separate user-level MCP server named `pretty-md` was added during troubleshooting, inspect it with `codex mcp get pretty-md`. Remove that redundant raw configuration with `codex mcp remove pretty-md` only if it points to this Site and was added for the old setup. That command removes the standalone server configuration, not the installed plugin or its app binding.

## Browser and phone use

Open https://pretty-md.yourshows12.chatgpt.site/ and choose **Choose file** or **Paste Markdown**. This works without plugin installation and renders local files on your device. It does not create a hosted tool-generated link.

Tool-generated links require the same account that created them and expire after 24 hours. Local hooks need Node.js 22 or later on the execution host and hook trust. They do not provide native mobile installation.

See [data handling](data-handling.md) for the service policy.

## Manifest compatibility

Version 0.4.11 declared a registered app but the installed Codex 0.155.1 client reported no app dependencies for its root portable manifest. Version 0.4.12 uses only `.codex-plugin/plugin.json`, referencing the same `.app.json`. A native `plugin/read` check resolves the Pretty MD app in this layout. Do not add a root `plugin.json` alongside it on this client: it masks the working app declaration. Tool invocation still needs verification in a fresh host session.
