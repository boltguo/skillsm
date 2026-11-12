# skillsm

Sync your Git-hosted skills repository to your AI tools.

**Your repository provides the skills; you choose what to install and where.** Pick your Agent tools and skills, review the plan, and sync. Your choices are remembered for next time.

There is no built-in repository or account to create. Source: [boltguo/skillsm](https://github.com/boltguo/skillsm).

## Get started

Requires Git and Node.js 22.13+ on the 22.x line, or 23.5+.

```bash
npm install -g skillsm
skillsm
```

The menu offers sync, installed and available skill lists, local status, and settings. Every interactive sync shows two choices: **Agent tools**, then **skills**. Use Space to toggle and Enter to continue. Previous choices are preselected; new skills start unchecked. Review additions, updates, replacements, and removals before confirming.

Or start directly:

```bash
skillsm sync --repo owner/skills
# Without installing the CLI globally:
npx skillsm sync --repo owner/skills
```

Sources can be GitHub shorthand, HTTPS or SSH Git URLs, or absolute / explicitly relative local Git paths. Private sources use your existing Git credentials. Local sources use committed content.

## Commands

| Command | What it does |
| --- | --- |
| `skillsm sync` | Choose Agent tools and skills, then preview and apply changes |
| `skillsm list` | List installed skills and their source and location |
| `skillsm list --remote` | Browse available skills, showing selected and installed items |
| `skillsm status` | Check local files against the last sync, without network access |
| `skillsm config` | Show the source, branch, target tools, scope, and config location |

```bash
skillsm sync --dry-run       # Compare with the repository without writing anything
skillsm sync --yes           # Apply saved selections, including planned removals
skillsm sync --skill writing review --agent codex --yes
skillsm sync --all --yes     # Explicitly select all skills currently in the repository
skillsm config --edit        # Guided settings editor
skillsm config --repo owner/another-repo
skillsm config --agent codex claude
skillsm config --ref main
skillsm config --ref default
```

Changing settings does not immediately change installed files. The next sync reconciles managed copies with your selected skills and tools. Unchecking an installed skill or a target tool schedules removal; the plan is shown before confirmation. Generated files are preserved. Switching repositories resets the skill selection and branch; choose what to install from the new source.

`--skill` sets the **complete** selection, not an additional filter. Omitted previously installed skills are scheduled for removal. `--all` selects the skills available on that run; future additions are still opt-in. Without saved choices, noninteractive sync requires `--skill` or `--all`.

## Sync behavior

| Repository or local change | Result |
| --- | --- |
| New skill | Show it unchecked; install only when selected |
| Selected skill | Install or update it on selected targets |
| Unchecked installed skill | Preview removal, then delete its unchanged managed files after confirmation |
| Changed selected skill | Update its managed files |
| Deleted skill, including the last skill | Remove its unchanged managed files |
| Unchanged skill | Leave its files untouched |
| Local edit or partially missing managed files | Report a conflict; apply none of the plan |
| Entire local skill directory missing | Reinstall it if it is still selected and available |
| Existing directory not managed by skillsm | Report a conflict; do not adopt it |
| Generated or other unmanaged files | Preserve them, including during removal |
| Previously removed skill selected again | Reinstall it alongside preserved files, unless paths collide |
| Fetch failure or invalid skill | Stop before applying any changes |

A successfully fetched repository with no skills is an empty inventory: sync proposes removing all active managed skills in this scope. `--yes` accepts removals too. A conflict blocks the entire plan, including unrelated removals.

`status` reports **Clean**, **Modified**, **Missing**, **Conflict**, or **Preserved**. Clean means the local managed files match the last sync, not that the remote repository has been checked. Use `sync --dry-run` to see remote changes.

This is a one-way sync. Edit and commit skills in your source repository; skillsm does not push local changes or merge conflicting edits. To resolve a conflict, back up your edits and restore the managed files, or move the affected skill directory aside before syncing again.

## Global or project scope

Commands operate **globally by default**, with Codex and Claude Code preselected. Add `--project` to use the current directory:

```bash
skillsm sync --project
skillsm status --project
skillsm config --project --edit
```

New projects inherit your global source, ref, tools, and skill selection until their own settings are saved. Their installations and records remain separate.

| Tool | Identifier | Global directory | Project directory |
| --- | --- | --- | --- |
| Codex | `codex` | `~/.agents/skills/` | `.agents/skills/` |
| Claude Code | `claude` | `~/.claude/skills/` | `.claude/skills/` |
| Antigravity App / IDE | `antigravity` | `~/.gemini/config/skills/` | `.agents/skills/` |
| Antigravity CLI | `antigravity-cli` | `~/.gemini/antigravity-cli/skills/` | `.agents/skills/` |

Tools sharing a destination use one copy. Settings and ownership records live in `~/.config/skillsm/` globally or `.skillsm/` per project. Keep these records: they identify which files skillsm may update or remove. Skill runtime dependencies are installed separately.

See [the reference](docs/skillsm.md) for source format and recovery details. Run `skillsm --help` for options.

## Development

```bash
npm ci
npm run check
npm test
node bin/skillsm.js
npm pack --dry-run
```

Tests use temporary homes and local Git repositories. Publishing runs syntax checks and the test suite. The npm package contains no skills.

To update the CLI itself, run `npm install -g skillsm@latest`.

Commit messages follow the Angular convention: `type(scope): subject`, for example `feat(sync): add saved skill selection`.

## Releases

Publishing a stable [GitHub Release](https://github.com/boltguo/skillsm/releases) triggers `.github/workflows/publish.yml`. The workflow verifies that the tag matches `package.json` and the lockfile, then runs the checks and tests through `prepublishOnly` before publishing to npm.

For the first functional release, publish a Release for `v0.1.0` from a commit containing this workflow. For later versions:

```bash
npm version patch -m "chore(release): %s"
git push origin main --follow-tags
```

Then publish a GitHub Release for the new tag. Pushing a tag alone, saving a draft, or publishing a prerelease does not publish to npm. Each npm version can only be published once.

Authentication uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) with GitHub OIDC. The package's trusted publisher must identify `boltguo/skillsm` and the workflow filename `publish.yml`. No `NPM_TOKEN` secret is required.

## License

[Apache-2.0](LICENSE)
