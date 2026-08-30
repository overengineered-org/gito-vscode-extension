#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "error: command required" >&2
  exit 64
fi

readonly required_node_version="24.14.0"
active_node_version=""
if command -v node >/dev/null 2>&1; then
  active_node_version="$(node -p 'process.versions.node')"
fi

if [[ "$active_node_version" != "$required_node_version" ]]; then
  readonly nvm_installation_directory="${NVM_DIR:-${HOME}/.nvm}"
  readonly node_24_binary_directory="${nvm_installation_directory}/versions/node/v${required_node_version}/bin"

  if [[ ! -x "${node_24_binary_directory}/node" || ! -x "${node_24_binary_directory}/npm" ]]; then
    echo "error: Node ${required_node_version} is required" >&2
    exit 1
  fi

  export PATH="${node_24_binary_directory}:${PATH}"
fi

if [[ "$(node -p 'process.versions.node')" != "$required_node_version" ]]; then
  echo "error: Node ${required_node_version} was not activated" >&2
  exit 1
fi

exec "$@"
