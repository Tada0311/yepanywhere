#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    tag: { type: "string" },
    commit: { type: "string" },
    tarball: { type: "string" },
    output: { type: "string" },
    repository: { type: "string" },
    "server-url": { type: "string", default: "https://github.com" },
  },
  strict: true,
});

function required(name) {
  const value = values[name];
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

const rootDir = path.resolve(import.meta.dirname, "..");
const version = required("version");
const tag = required("tag");
const commit = required("commit");
const tarball = path.resolve(required("tarball"));
const outputDir = path.resolve(required("output"));
const repository = required("repository");
const serverUrl = values["server-url"].replace(/\/+$/, "");
const nodeRuntimeVersion = process.versions.node;
const [nodeMajor, nodeMinor] = nodeRuntimeVersion.split(".").map(Number);
const nodeRuntimeSupported =
  (nodeMajor === 22 && nodeMinor >= 16) ||
  (nodeMajor === 23 && nodeMinor >= 11) ||
  (nodeMajor === 24 && nodeMinor >= 10) ||
  nodeMajor > 24;
if (!nodeRuntimeSupported) {
  throw new Error(
    `Node.js ${nodeRuntimeVersion} cannot be used as the managed runtime`,
  );
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
  throw new Error(`invalid release version: ${version}`);
}
if (tag !== `codexdevbox-v${version}`) {
  throw new Error(`tag ${tag} does not match version ${version}`);
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error(`invalid git commit: ${commit}`);
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error(`invalid GitHub repository: ${repository}`);
}

const expectedTarballName = `yepanywhere-${version}.tgz`;
if (path.basename(tarball) !== expectedTarballName) {
  throw new Error(
    `expected tarball ${expectedTarballName}, got ${path.basename(tarball)}`,
  );
}
if (!fs.existsSync(tarball)) {
  throw new Error(`tarball not found: ${tarball}`);
}

const rootPackage = JSON.parse(
  fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
);
const releaseBaseUrl = `${serverUrl}/${repository}/releases/download/${tag}`;
const latestInstallerUrl = `${serverUrl}/${repository}/releases/latest/download/install-codexdevbox.sh`;
const sha256 = createHash("sha256")
  .update(fs.readFileSync(tarball))
  .digest("hex");

fs.mkdirSync(outputDir, { recursive: true });

const manifest = {
  schemaVersion: 1,
  distribution: "codexdevbox",
  version,
  tag,
  gitCommit: commit,
  asset: expectedTarballName,
  sha256,
  node: rootPackage.engines.node,
  nodeRuntimeVersion,
  codex: rootPackage.yepAnywhere.codexCli,
  repository,
  releaseUrl: `${serverUrl}/${repository}/releases/tag/${tag}`,
};
fs.writeFileSync(
  path.join(outputDir, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(outputDir, "SHA256SUMS"),
  `${sha256}  ${expectedTarballName}\n`,
);

const installerTemplate = fs.readFileSync(
  path.join(rootDir, "scripts/codexdevbox-install.sh.in"),
  "utf8",
);
const installer = installerTemplate
  .replaceAll("@@RELEASE_BASE_URL@@", releaseBaseUrl)
  .replaceAll("@@NODE_RUNTIME_VERSION@@", nodeRuntimeVersion);
fs.writeFileSync(path.join(outputDir, "install-codexdevbox.sh"), installer, {
  mode: 0o755,
});
fs.chmodSync(path.join(outputDir, "install-codexdevbox.sh"), 0o755);

fs.writeFileSync(
  path.join(outputDir, "release-notes.md"),
  `## Yep Anywhere Codex DevBox v${version}

Prebuilt release for the Codex Desktop plus DevBox mobile handoff workflow.

### Install on macOS or Linux

\`\`\`bash
curl -fL ${latestInstallerUrl} -o /tmp/install-codexdevbox.sh
bash /tmp/install-codexdevbox.sh
\`\`\`

The installer verifies the SHA-256, installs into \`$HOME/.local\`, and writes a
machine-readable state file to \`$HOME/.codexdevbox/install.json\`.

### Release metadata

- Version: \`${version}\`
- Git commit: \`${commit}\`
- Package: \`${expectedTarballName}\`
- SHA-256: \`${sha256}\`
- Node.js: \`${rootPackage.engines.node}\`
- Managed Node.js fallback: \`${nodeRuntimeVersion}\`
`,
);

console.log(`Prepared Codex DevBox release ${version}`);
console.log(`Manifest: ${path.join(outputDir, "release-manifest.json")}`);
console.log(`Installer: ${path.join(outputDir, "install-codexdevbox.sh")}`);
