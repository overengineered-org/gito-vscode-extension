# Security

Report suspected vulnerabilities privately through the repository's GitHub
Security Advisory form:

<https://github.com/overengineered-org/gito-vscode-extension/security/advisories/new>

Do not disclose secrets, access tokens, private account information, or an
unfixed exploit in a public issue. Include the affected version, a minimal
reproduction, impact, and a safe contact channel. We will acknowledge a
report, investigate, and coordinate a fix and disclosure timeline.

Git'o has no service backend or credential store. Provider sessions come from
VS Code and remain opaque to the webview. The production security boundary is
checked by TypeScript tests, Gitleaks, CodeQL, dependency review, package
allowlist validation, and the production audit.

## Local filesystem boundary

Git'o treats a VS Code trusted workspace as a trusted local filesystem. It
checks repository identity and relevant filesystem state around local
operations, and fails closed when it detects a stale or replaced path. These
checks reduce ordinary race and replacement risk; they do not isolate Git'o
from another process running as the same operating-system user. That process
may change files or paths outside Git'o's control. This is not a cross-user
privilege boundary.

Do not open an untrusted repository in a trusted workspace. Report any
reproducible bypass of Git'o's workspace-trust, path, or credential boundaries
privately.
