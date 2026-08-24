module.exports = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer"],
    ["@semantic-release/release-notes-generator"],
    [
      "@semantic-release/github",
      {
        assets: [
          {
            path: "dist/gito-*.vsix",
            label: "Git'o VSIX",
          },
          {
            path: "dist/gito-*.vsix.sha256",
            label: "SHA-256 checksum",
          },
          {
            path: "dist/release-metadata.json",
            label: "Release provenance",
          },
        ],
        failComment: false,
        failTitle: false,
        releasedLabels: false,
        successComment: false,
      },
    ],
  ],
};
