# Privacy

Git'o is local-first. It has no Git'o account, backend, telemetry, analytics,
diagnostics upload, tracking pixel, advertisement, remote font, or feature
flag service.

Repository discovery and ordinary local Git API state come from VS Code's
bundled Git extension. CLI-backed features use the configured absolute
`git.path` or the executable exposed by that extension. After the user
explicitly connects GitHub through VS Code, Git'o requests
provider account/profile data and read-only data for the selected repository.
Git'o does not send repository content to a Git'o service.

Provider tokens are opaque and are used only for the request that needs them.
They are never sent to a webview or stored in settings, files, logs, caches,
extension state, fixtures, Git, or the VSIX.

Optional developer diagnostics are local-only and disabled by default. When
enabled by the user-level setting, Git'o records fixed event names, outcomes,
durations, and suppressed-event counts in a VS Code output channel. It does not record credentials,
repository content, commit messages, provider responses, or full paths, and it
never uploads or collects the output.

Git'o stores one local setup marker after the native first-install walkthrough
opens successfully. The marker only prevents that walkthrough from reopening
automatically; it contains no account, provider, repository, or completion
data.

Disconnecting a provider clears Git'o's current connection state and normalized
cached provider data. VS Code and the provider may retain their own account
state under their separate privacy policies.
