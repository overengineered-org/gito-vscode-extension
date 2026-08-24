# Support

Use [GitHub Issues](https://github.com/overengineered-org/gito-vscode-extension/issues)
for reproducible product defects and focused feature proposals. Use the
matching issue form and include:

- Git'o version and exact VS Code build
- operating system and desktop/remote context
- provider and repository host, without credentials or private URLs
- smallest reproduction steps and expected versus actual behavior
- relevant logs with tokens, headers, emails, and private repository content removed

For a local timing trace, run **Git'o: Toggle Developer Diagnostics**, reproduce
the issue, then run **Git'o: Open Developer Diagnostics**. Turn diagnostics off
after capture. The default-off channel contains fixed event names, outcomes,
durations, and suppressed-event counts only; Git'o never uploads it.

Git'o targets VS Code desktop and remote Extension Hosts where the bundled Git
API is exposed, but remote-host behavior is not live-proven by current
validation. Native worktree create/remove requires a desktop `file:` repository.
It does not support vscode.dev web extensions, GitHub Enterprise Server,
GitLab, Bitbucket, or provider write operations such as PR
approval or merge.
