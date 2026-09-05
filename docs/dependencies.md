# Reproducible dependency setup

The repository uses Bun 1.4.0, Node 22.22.3, and Rust 1.93.1. Install Git, Rustup and a native compiler for your platform, then run:

```sh
rustup toolchain install 1.93.1 --profile minimal
bun run setup:deps
bun run check
```

`setup:deps` includes the repository's `bun install --frozen-lockfile`. It works from a clean checkout without neighboring repositories, previously built native binaries, SSH credentials, or global Bun link registrations. HTTPS access to GitHub, the npm registry and the Rust dependency registry is required for a first build.

## Locked inputs

[dependencies.lock.json](../dependencies.lock.json) pins every unpublished source dependency and the required tool versions:

| Dependency | Git revision | Additional source input |
| --- | --- | --- |
| better-trigger | `943958579cd75853f5fd699156e41b075a2a0826` | None |
| mad-dom | `2672439a55f0f43f2fa30826b82ac88e91095fcf` | SHA-256 verified [React 19 compatibility patch](../patches/mad-dom-react19.patch) |

The mad-dom patch captures the upstream changes made through the authorized Herdr Codex agent: the real `HTMLIFrameElement` constructor, standard semantic element selection, `oninput` event-handler properties, type declarations, and React 19 interaction regressions. It includes its exact Bun lockfile change and regression fixtures. No upstream commit or publication is required to reproduce this checkout.

Each dependency is fetched by its complete Git object ID into `.local-deps/sources`. The setup script verifies the checked-out revision and patch hashes before building. It uses the dependency's frozen Bun lockfile and Cargo's `--locked` mode. The native mad-dom binding is compiled for the host platform from the pinned Rust source; a developer's platform binary is never checked in or copied into another platform's install.

The better-trigger build follows its worker dependency graph, including the SDK, internal packages and embedded dashboard. The SDK and embedded worker remain in the same source workspace, preserving their shared runtime context. The setup script checks exported build artifacts and resolves each linked dependency from its actual consuming workspace.

Bun link registration uses `.local-deps/bun-global`, and executable links use `.local-deps/bin`. The repository's `bunfig.toml` points later plain `bun install` commands at that same local registry. A second checkout gets its own registrations. This uses Bun's documented [`install.globalDir` / `BUN_INSTALL_GLOBAL_DIR`](https://bun.com/docs/runtime/bunfig#installglobaldir) configuration and [`bun link`](https://bun.com/docs/pm/cli/link) package registration.

## Updating or repairing a generated dependency

Update the Git revision in the dependency manifest, or replace the checked-in patch and its SHA-256 value. Rerun setup, then run all applicable acceptance commands. A changed revision or patch produces a different generated checkout directory.

The script records a fingerprint of the pinned checkout plus patch. On later runs, it refuses to overwrite unexpected local changes in that generated directory. Preserve any wanted edits before removing the reported directory and rerunning setup. Generated source and build output can otherwise be recreated by removing `.local-deps` and `node_modules`, then running `bun run setup:deps`.

`bun run setup:local` deliberately selects mutable neighboring repositories (or `BETTER_TRIGGER_SOURCE` / `MAD_DOM_SOURCE`) for upstream development. It registers their existing artifacts in this checkout's local Bun registry, then requires `bun install` to refresh consumers. This explicitly bypasses the pinned source manifest and patch checks. Its output is not reproducibility evidence; use `setup:deps` for clean-checkout verification and CI. Switching back to pinned mode may require removing `node_modules` so Bun replaces previous links.

## Acceptance gates

```sh
bun run check
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/agent_flow_test bun run test:integration
bunx --no-install playwright install chromium
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/agent_flow_test bun run test:browser
```

The database connection must permit creation and deletion of the isolated test databases. The explicit integration command rejects a missing connection instead of silently skipping database coverage. Browser tests use Chromium and real HTTP/WebSocket behavior; mad-dom tests do not establish layout, focus or browser integration correctness.

[CI](../.github/workflows/check.yml) provisions PostgreSQL 15, builds the pinned source dependencies, and executes all three gates. A hosted CI machine has no user's Herdr session. The additional `bun run test:herdr` gate runs inside a Herdr-managed pane (`HERDR_ENV=1`) and exercises owned resources in that session. Hosted CI does not claim to execute that live Herdr gate.
