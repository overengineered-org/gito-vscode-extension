# Release recovery

Published releases are immutable. Recovery is restricted to authorized
maintainers and remains separate from normal CI.

Any recovery must use the exact installed-tested artifact associated with the
intended tagged source. Before a release change, authorized maintainers must
approve the change and verify source and tag identity, the latest completed
successful `main`/`push` CI, CodeQL, dependency-review, and Gitleaks runs for
the exact commit, plus independent run readback, checksum, archive contents,
embedded version, and source-tree fingerprint. Missing runs or a latest failed
run stop recovery. Recovery never rebuilds the package or replaces the
verified artifact bytes.

The installed-tested release and recovery evidence artifacts are retained for
up to 90 days, matching the public-repository maximum subject to any
repository, organization, or enterprise cap. Retention is a recovery window,
not an immutability guarantee. Recovery after that window requires an existing
immutable release or a separately approved evidence store.

Marketplace publication remains a separate authorized-maintainer approval
using the same verified release artifact.

Local source, builds, and audit notes do not prove remote release or Marketplace
state.
