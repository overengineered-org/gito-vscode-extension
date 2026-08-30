module.exports = {
  git: {
    commit: false,
    requireBranch: "main",
    tagName: "v${version}",
  },
  github: {
    assets: ["dist/gito-*.vsix", "dist/gito-*.vsix.sha256"],
    release: true,
    releaseName: "v${version}",
  },
  hooks: {
    "before:git:release": "node scripts/verify-release-package.mjs ${version}",
  },
  npm: false,
  plugins: {
    "@release-it/conventional-changelog": {
      infile: false,
      preset: { name: "conventionalcommits" },
    },
  },
};
