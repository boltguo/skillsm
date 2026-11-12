# skillsm reference

## Repository and selection

One Git repository provides the available skills for each scope. You choose the skills and Agent tools to install to. Both choices are remembered, and shared target directories are deduplicated.

Every interactive `sync` shows the target-tool checklist followed by the skill checklist. Previously selected skills are checked; new skills start unchecked. On first use, no skills are selected unless existing managed installations can be used as defaults. Selecting no skills is allowed and schedules removal of active managed copies.

`list` shows installed records without network access. `list --remote` fetches the source and displays selected, unselected, and installed skills without changing settings. `status` inspects local file contents offline. `config` shows settings; `config --edit` changes the source, branch, and target tools.

For noninteractive use, `sync --yes` uses saved selections. Without saved selections or existing managed skills, pass `--skill <names>` or `--all` explicitly. `--skill` replaces the complete selection; omitted installed skills will be removed. `--all` selects all skills available now, not future additions. These flags cannot be combined. Supplying `--skill` or `--all` skips the skill checklist, and supplying `--agent` skips the tool checklist.

Unchecking an installed skill schedules its removal. No files are deleted until you accept the preview, or explicitly use `--yes`. Local modifications remain protected. Removing a skill upstream also schedules removal and drops it from the saved selection. If it reappears, select it again to install it.

Existing records from the earlier full-repository sync implementation preselect installed skills when no selection has been saved. They do not implicitly select newly discovered skills.

## Settings

```bash
skillsm config
skillsm config --edit
skillsm config --repo owner/skills
skillsm config --repo git@github.com:owner/private-skills.git
skillsm config --repo /absolute/path/to/local-repo
skillsm config --ref release --agent codex
skillsm config --ref default
skillsm config --repo owner/other --dry-run
```

There is no default repository. Interactive sync asks for a missing source. Scripts and previews must supply `--repo` or use previously saved settings.

Direct config flags save settings immediately without touching installed skills. The editor asks before saving. Switching sources resets the skill selection and the ref unless `--ref` is supplied. The next sync lets you choose from the new source, then previews replacements and removal of skills or targets no longer selected.

`--agent` accepts tools separated by spaces, commas, or repeated flags. At least one target must remain configured. Sync flags override saved settings and are saved after a successful sync. A fetch failure, validation error, planned conflict, preview, or declined confirmation does not save these overrides.

## Scope

Without `--project`, commands always use the global scope, even inside a configured project. With `--project`, they use the current directory, not the nearest Git root.

New projects inherit the global source, ref, tools, and skill selection. Saving project settings makes them independent. Global and project ownership records never overlap.

```text
~/.config/skillsm/       # Global records
.skillsm/               # Project records
  config.json           # Repository, ref, target tools, and selected skill names
  state.json            # Managed file fingerprints and source commits
  lock                  # Present during a modifying command
```

State also retains a small record of removed skill directories. This allows reinstallation alongside preserved output files without treating those files as managed content. An upstream file colliding with a preserved file remains a conflict. Missing removed directories are hidden from status.

Keep the records. Without them, existing directories are unmanaged. Do not commit locks or temporary files. Stored target keys are relative so project directories can be moved.

## Preview and apply

```bash
skillsm sync --dry-run
skillsm sync
skillsm sync --yes
```

Sync fetches a shallow clone and validates the entire discovered inventory before planning any mutations. The preview shows the source commit, selected/available skill counts, and per-target install, update, replace, remove, unchanged, and conflict counts. The whole source is validated before planning, even when only some skills are selected.

A valid empty inventory or an explicitly empty selection schedules removal of every active managed skill in that scope. Fetch failures and malformed skills are errors, not empty inventories. Deletions and source replacements are shown before the final confirmation. `--yes` accepts the complete plan, including deletions; it never overrides conflicts.

A preview may fetch into a temporary directory, but writes no target files, config, state, or lock. A noninteractive sync requires `--yes` or `--dry-run`. Running without a command outside a terminal prints help.

## Local changes and conflicts

`status` compares managed files with their saved fingerprints, including executable permissions:

- **Clean:** managed files match the last sync.
- **Modified:** one or more managed files changed.
- **Missing:** a managed file or the entire directory is absent.
- **Conflict:** an unsafe path or unexpected file type prevents inspection.
- **Preserved:** the skill was removed, but its local directory remains for unmanaged files.

Source or target configuration changes are also flagged. Status does not fetch or claim that the remote source is current; use `sync --dry-run` for that comparison.

Any planned conflict prevents the entire sync from changing files or settings. This includes local edits, partially missing managed files, unmanaged directories, file collisions, and unsafe destination paths. A completely absent managed directory can be reinstalled; an already absent directory scheduled for removal only needs its record retired.

Restore managed files or move the affected directory aside after backing up your edits. There is no force-overwrite mode and no automatic merge or push. Unmanaged files are never uploaded.

## Source format

A skill is a directory containing a regular `SKILL.md` with YAML frontmatter:

```yaml
---
name: example-skill
description: What this skill does and when to use it.
---
```

Names use lowercase letters, digits, and single hyphens between segments, up to 64 characters. The metadata name becomes the installed directory name. Scripts, references, templates, and assets inside the skill are copied together.

Root-level and nested skills are supported. Once a skill is found, its directory is one bundle; nested skills are not discovered separately. Local agent directories (`.agents`, `.agent`, `.claude`), `.git`, `.skillsm`, `node_modules`, `__pycache__`, and `.DS_Store` are excluded.

Directory symlinks are not followed. Duplicate names, invalid metadata, and symlinks inside a skill abort the sync before any target is changed. Place the actual skill directories in the source repository, rather than links under local agent directories.

Branches and tags are supported via `--ref`; commit SHA checkout is not supported. Private repositories use existing Git credentials. Local sources read committed content. Individual skill dependencies are not automatically installed.

## Failure recovery

The complete plan is checked before execution. Desired skills are installed or replaced before old targets are removed. Each directory is staged before replacement, and a state-save failure restores that directory. Managed files are rechecked before mutation.

Targets commit independently. If an execution error occurs after some targets succeeded, sync stops; completed targets remain and retain their ownership records. Resolve the issue and rerun sync. This is not a single transaction across all targets, and it does not lock out external editors.

An interrupted process may leave `.skillsm-stage-*`, `.skillsm-backup-*`, or a scope lock. Preserve useful backups and verify that no skillsm process is running before removing a stale lock. Automatic recovery after power loss is not provided.

Exit codes: `0` for success or a declined confirmation, `1` for invalid arguments, fetch failures, validation errors, conflicts, or execution failures, and `130` for an interrupted prompt.

## Development and release

```bash
npm ci
npm run check
npm test
npm pack --dry-run
npm publish --access public
```

Tests use temporary homes and local Git fixtures. The prepublish hook runs syntax checks and tests. Skills are fetched at runtime and are not bundled with the CLI.

Commit messages use the Angular format `type(scope): subject`. Use an imperative subject without a trailing period. The repository is [boltguo/skillsm](https://github.com/boltguo/skillsm).

## Automatic npm publishing

The `Publish to npm` workflow runs when a stable GitHub Release is published. It checks out that release's tag, requires `v<package.json version>`, checks both lockfile version fields, and runs `npm publish --access public`. The existing `prepublishOnly` hook runs syntax checks and the full test suite before upload.

The workflow uses GitHub-hosted Ubuntu, Node.js 24, npm 11, and `id-token: write` for OIDC. It does not use a saved npm token. Releases are serialized, and publishing a draft, prerelease, or standalone tag does not upload a package.

Configure the trusted publisher once on npm for package `skillsm`:

- Provider: GitHub Actions
- Repository owner: `boltguo`
- Repository: `skillsm`
- Workflow filename: `publish.yml`
- Permission: publish
- Environment: unset

The equivalent authenticated CLI command is:

```bash
npm trust github skillsm --repo boltguo/skillsm --file publish.yml --allow-publish
```

For `v0.1.0`, use a commit that includes this workflow. For subsequent releases, run `npm version patch -m "chore(release): %s"` (or `minor` / `major`), push the commit and tag, then publish the corresponding GitHub Release. This keeps version commits in Angular format. A release tag must exactly match the package version.

Check the workflow run for the result. If a run failed before upload, fix the cause and rerun it. Once a version is published, use a new version for further changes; npm does not allow overwriting an existing version.
