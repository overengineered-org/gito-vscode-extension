#!/usr/bin/env bash
set -euo pipefail

readonly codeql_bundle_version="2.26.4"
readonly codeql_release_tag="codeql-bundle-v${codeql_bundle_version}"
readonly codeql_bundle_name="codeql-bundle-linux64.tar.gz"
readonly codeql_release_url="https://github.com/github/codeql-action/releases/download/${codeql_release_tag}"
readonly codeql_installation_root="${CODEQL_INSTALLATION_ROOT:?CODEQL_INSTALLATION_ROOT is required}"
readonly versioned_codeql_directory="${codeql_installation_root}/${codeql_bundle_version}"
readonly codeql_binary_path="${versioned_codeql_directory}/codeql"

if [[ ! -x "$codeql_binary_path" ]]; then
  mkdir -p "$codeql_installation_root"
  temporary_installation_directory="$(mktemp -d "${codeql_installation_root}/install-${codeql_bundle_version}.XXXXXX")"
  trap 'rm -rf -- "$temporary_installation_directory"' EXIT

  curl --fail --location --retry 4 --retry-all-errors \
    --output "${temporary_installation_directory}/${codeql_bundle_name}" \
    "${codeql_release_url}/${codeql_bundle_name}"
  curl --fail --location --retry 4 --retry-all-errors \
    --output "${temporary_installation_directory}/${codeql_bundle_name}.checksum.txt" \
    "${codeql_release_url}/${codeql_bundle_name}.checksum.txt"
  (
    cd "$temporary_installation_directory"
    sha256sum --check "${codeql_bundle_name}.checksum.txt"
    tar --extract --gzip --file "$codeql_bundle_name"
  )
  rm -rf -- "$versioned_codeql_directory"
  mv "${temporary_installation_directory}/codeql" "$versioned_codeql_directory"
fi

"$codeql_binary_path" version
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "binary_path=$codeql_binary_path" >> "$GITHUB_OUTPUT"
else
  echo "$codeql_binary_path"
fi
