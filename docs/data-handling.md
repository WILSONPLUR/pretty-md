# Data handling

Pretty MD sends the Markdown you explicitly render to the publisher-operated hosted service at `pretty-md.yourshows12.chatgpt.site`. Documents are stored in R2 with opaque IDs and authenticated user ownership. Anyone holding a newly generated reader link can read the document, edit locally, and download a copy without login. Saving changes to the hosted document still requires its signed-in owner. Older documents without explicit link-access metadata retain account-only reads; render again to create a no-login link.

Reader links expire 24 hours after creation; opening or saving does not extend expiry. Expired objects are deleted when accessed or during a later render sweep, so physical deletion can happen later while the service is idle. Documents may also remain in normal conversation tool history. The service accepts up to 2 MB of UTF-8 Markdown per document. Reader preferences stay in browser local storage.

Trusted local hooks keep change-tracking signatures and temporary plan delivery state in the host-provided plugin data directory. Pending plan text is removed after confirmed delivery; receipts and pending state expire on a subsequent hook event after 24 hours. There is no background deletion task.

The publisher operates this shared service as an early release. Report service issues through the repository’s GitHub Issues page; do not post private content or credentials. The MIT license covers source code and does not promise hosted service availability.
