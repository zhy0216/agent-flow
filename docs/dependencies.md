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
| mad-dom | `8f86acb64b159473c5b3c448979a1d2f0bba640f` | None |

The pinned mad-dom commit contains the changes made in its local source repository through Herdr: the real `HTMLIFrameElement` constructor, standard semantic element selection, `oninput` event-handler properties, type declarations, and React 19 interaction regressions. It includes the Bun lockfile change and regression fixtures and is available from the upstream repository. No additional patch is needed.

Each dependency is fetched by its complete Git object ID into `.local-deps/sources`. The setup script verifies the checked-out revision before building. It uses the dependency's frozen Bun lockfile and Cargo's `--locked` mode. The native mad-dom binding is compiled for the host platform from the pinned Rust source; a developer's platform binary is never checked in or copied into another platform's install.

The better-trigger build follows its worker dependency graph, including the SDK, internal packages and embedded dashboard. The SDK and embedded worker remain in the same source workspace, preserving their shared runtime context. The setup script checks exported build artifacts and resolves each linked dependency from its actual consuming workspace.

Bun link registration uses `.local-deps/bun-global`, and executable links use `.local-deps/bin`. The repository's `bunfig.toml` points later plain `bun install` commands at that same local registry. A second checkout gets its own registrations. This uses Bun's documented [`install.globalDir` / `BUN_INSTALL_GLOBAL_DIR`](https://bun.com/docs/runtime/bunfig#installglobaldir) configuration and [`bun link`](https://bun.com/docs/pm/cli/link) package registration.

## Updating or repairing a generated dependency

For changes to a local technology stack, dispatch an agent through Herdr with its working directory set to that stack's actual source repository. For mad-dom, use `/Users/yang/workspace/mad-dom`. Apply the same workflow to other local dependencies; see [AGENTS.md](../AGENTS.md). Make and verify the fix in that repository, then use `setup:local` for local integration.

Once the upstream fix has a fetchable commit, update the Git revision in the dependency manifest and remove any patch entries and files superseded by that revision. Do not create or extend checked-in patches as a substitute for editing the local source repository. Rerun setup, then run all applicable acceptance commands. A changed revision or patch list produces a different generated checkout directory.

The script records a receipt and fingerprint of the pinned source inputs (the current manifest has empty patch lists). On later runs, it refuses to overwrite unexpected local changes in that generated directory. Preserve any wanted edits before removing the reported directory and rerunning setup. Generated source and build output can otherwise be recreated by removing `.local-deps` and `node_modules`, then running `bun run setup:deps`.

`bun run setup:local` deliberately selects mutable neighboring repositories (or `BETTER_TRIGGER_SOURCE` / `MAD_DOM_SOURCE`) for upstream development. It registers their existing artifacts in this checkout's local Bun registry, then requires `bun install` to refresh consumers. This explicitly bypasses the pinned source manifest and patch checks. Its output is not reproducibility evidence; use `setup:deps` for clean-checkout verification and CI. Switching back to pinned mode may require removing `node_modules` so Bun replaces previous links.

## Acceptance gates

`bun run audit:deps` audits the lockfile against the official npm registry without changing the installation registry. Network/registry errors remain failures. The lockfile uses a narrow `@esbuild-kit/core-utils` → `esbuild: 0.25.12` override to remove the affected esbuild 0.18.20 instance; Drizzle Kit remains 0.31.10. Config loading, migration generation, Node CJS/ESM compatibility and frozen installation were verified; see the [dated acceptance record](acceptance.md#2026-09-06-仓库改进验收) for the actual audit result. An audit result describes that run, not a permanent guarantee.

`bun run test:setup` runs 39 fixture regressions and is included in `check`. Temporary Git/package fixtures cover source drift and damaged/missing receipts without overwriting bytes, path traversal and symlink escapes, wrong package identity/missing artifacts, failed staging cleanup and competing publication, consumer resolution, and separate checkout Bun registrations. These tests need neither network nor a full Rust build and do not mutate upstream repositories or the user global registry. The real pinned `setup:deps` build remains the success-path gate.

```sh
bun run check
bun run test:setup
bun run audit:deps
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:integration
bunx --no-install playwright install chromium
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:browser
```

The database connection must permit creation and deletion of the isolated test databases. The explicit integration command rejects a missing connection instead of silently skipping database coverage. Browser tests use Chromium and real HTTP/WebSocket behavior; mad-dom tests do not establish layout, focus or browser integration correctness.

[CI](../.github/workflows/check.yml) provisions PostgreSQL 15, builds the pinned source dependencies, and executes dependency auditing, `check` (including setup regressions), integration and browser gates. A hosted CI machine has no user's Herdr session. The additional `bun run test:herdr` gate runs inside a Herdr-managed pane (`HERDR_ENV=1`) and exercises owned resources in that session. Hosted CI does not claim to execute that live Herdr gate.
