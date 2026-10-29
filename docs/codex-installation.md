# Install Pretty MD in Codex and ChatGPT desktop

Requires Git and a supported desktop Codex or ChatGPT client. Node.js 22 or later must be on the execution host’s PATH for the optional lifecycle hooks. Installing the hosted reader does not require npm or a local build.

1. Clone the public repository using its GitHub **Code → HTTPS** URL: `git clone https://github.com/WILSONPLUR/pretty-md.git`.
2. Open that clone as a project in the desktop app. Restart the app so it discovers `.agents/plugins/marketplace.json`.
3. Open Plugins, select **Pretty MD Local**, and install **pretty-md**.
4. Complete the hosted MCP connection and Sign in with ChatGPT when prompted. The endpoint and OAuth resource are both `https://pretty-md.yourshows12.chatgpt.site/mcp`. Supply your own account authorization; no shared token is needed.
5. Review and trust the bundled hooks if you want local Markdown change detection and plan-link recovery. The reader can be invoked explicitly without hook trust.
6. Start a new chat and ask `@pretty-md render a short Markdown example` (or invoke `$pretty-md` in Codex).

Alternatively, run `codex plugin marketplace add WILSONPLUR/pretty-md` and install from `/plugins` or the desktop Plugins directory. A clone can also be registered explicitly with `codex plugin marketplace add /absolute/path/to/clone`.

## Remote and mobile

Install on the connected execution host for Codex Remote. Keep that host online. Open the returned reader link on your phone and sign in with the same ChatGPT account that created the document. Browser reader links expire after 24 hours. A local marketplace install does not by itself provide native mobile ChatGPT plugin installation. Hooks require a supported local execution environment and trust; they are not a guarantee of automatic invocation on every client.

## Updates and removal

For a manual clone, run `git pull --ff-only`, then refresh/reinstall Pretty MD from that marketplace and restart the app or CLI session. Codex loads a cached installed copy, so editing the clone alone may not update it. For a configured Git marketplace, run `codex plugin marketplace upgrade pretty-md-local`, then refresh the installed plugin. Re-review hook trust when definitions change.

Uninstall in Plugins (or `/plugins`). To remove a configured source, run `codex plugin marketplace remove pretty-md-local`. This does not delete your clone. Avoid enabling duplicate installs from multiple marketplaces.

## Hosted service

The service is operated by the publisher of this repository. It requires account authentication for document operations. See [data handling](data-handling.md). If connection or phone sign-in fails, report the client version and error without including private Markdown or access tokens. Public availability requires the release checks in [release instructions](release.md).
