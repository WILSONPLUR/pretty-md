# GitHub release

The owner creates an empty public GitHub repository and supplies its HTTPS URL. Run `npm ci`, `npm run build`, `npm test`, and `npm run validate` before export.

Run `npm run release:export -- --repository https://github.com/OWNER/REPO`. This creates `output/github-release` from an explicit file list, adds repository metadata, and excludes local Sites binding, Git history, credentials, and personal example documents. It never overwrites an existing export. Inspect the resulting tree before initializing Git there and pushing to the empty repository. Tag the exact version in `plugin.json` and `package.json`. Do not push this workspace’s existing history to the public repository.

The public export builds without a Sites project binding. To self-host, copy `.openai/hosting.example.json` to `.openai/hosting.json` and fill in your own Sites project ID. The publisher retains its original project binding and deployment workflow in the development checkout.

Before announcing general availability, use a second account to install from a fresh clone, authenticate MCP, render, and open the reader on a phone. Check trusted local hooks, Remote use, anonymous API rejection, cross-user read/save rejection, and expiry. Verify the Site is public and authenticated document operations remain required. Never substitute a shared bearer token for user sign-in.

Native mobile ChatGPT installation is deferred to a later public-directory submission with a package that excludes lifecycle hooks.

## Registered Sites connection

The GitHub/local marketplace package includes `.app.json` and uses the existing Sites app binding. Do not replace it with a raw `/mcp` OAuth entry. Verify access with a second account before announcing general public availability.

GitHub distribution is separate from directory submission. Do not upload this source package unchanged to the public directory: its app binding and lifecycle hooks require a separate supported submission flow that preserves the canonical Site integration. Public review and publisher setup remain incomplete.
