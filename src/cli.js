import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { AGENTS, context, exists, readConfig, readState, targetRoot, targets, withLock, writeJSON } from './store.js';
import { checkout, discover, normalizeRepo, snapshot } from './repository.js';
import { planSync, applyInstall, removeInstall, inspectInstall } from './install.js';

const HELP = `skillsm - Sync your skills repository to your AI tools

Usage: skillsm <command> [options]

Commands:
  sync             Choose tools and skills, then preview and apply changes
  list             List installed skills; use --remote to browse the repository
  status           Inspect local managed files (offline)
  config           Show settings; use --edit to change them
  (no command)     Open the menu

Options:
  --repo <source>   GitHub owner/repo, a Git URL, or a local Git path
  --ref <ref>       Branch or tag; use default for the default branch
  --agent <tool>    codex, claude, antigravity, antigravity-cli
                    Separate multiple tools with spaces, commas, or flags
  --skill <name>    With sync: set the complete skill selection (multiple allowed)
  --all            With sync: select all currently available skills
  --remote         With list: browse available and selected repository skills
  --project        Use the current directory instead of the global scope
  --yes, -y        With sync: apply the plan, including removals, without prompts
  --dry-run        Preview sync or config changes without writing anything
  --edit           With config: interactively edit settings
  --help, -h       Show help
  --version, -v    Show version

Defaults: global | Codex + Claude Code | no repository configured
Choose skills from your repository. Choices are remembered; new skills are opt-in.

Examples:
  skillsm sync --repo owner/skills
  skillsm sync
  skillsm sync --dry-run
  skillsm sync --project
  skillsm sync --skill example-skill --agent codex --yes
  skillsm list
  skillsm list --remote
  skillsm status
  skillsm config
  skillsm config --edit
`;

function options(argv) {
  const expanded = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent' || argv[i] === '--skill') {
      const flag = argv[i];
      let count = 0;
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        for (const value of argv[++i].split(',').filter(Boolean)) { expanded.push(flag, value); count++; }
      }
      if (!count) throw new Error(`${flag} requires a value`);
    } else expanded.push(argv[i]);
  }
  const { values, positionals } = parseArgs({ args: expanded, allowPositionals: true, options: {
    repo: { type: 'string' }, ref: { type: 'string' }, agent: { type: 'string', multiple: true }, skill: { type: 'string', multiple: true },
    all: { type: 'boolean' }, remote: { type: 'boolean' },
    project: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, 'dry-run': { type: 'boolean' },
    edit: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (positionals.length > 1) throw new Error('Use one command: sync, list, status, or config.');
  const command = positionals[0];
  if (command && !['sync', 'list', 'status', 'config'].includes(command)) throw new Error(`Unknown command: ${command}. Use sync, list, status, or config.`);
  if ((values.skill || values.all) && command !== 'sync') throw new Error('--skill and --all are only supported by sync.');
  if (values.skill && values.all) throw new Error('Use either --skill or --all.');
  if (values.remote && command !== 'list') throw new Error('--remote is only supported by list.');
  if (values.skill) values.skill = [...new Set(values.skill.flatMap((v) => v.split(',')))];
  if (values.skill && !values.skill.length) throw new Error('--skill requires a name.');
  if (values.agent) {
    values.agent = [...new Set(values.agent.flatMap((v) => v.split(',')))];
    if (!values.agent.length || values.agent.some((a) => !Object.hasOwn(AGENTS, a))) throw new Error(`Choose target tools from: ${Object.keys(AGENTS).join(', ')}`);
  }
  if (values.edit && command !== 'config') throw new Error('--edit is only supported by config.');
  if (values.edit && values['dry-run']) throw new Error('Use config flags with --dry-run, or --edit for guided changes.');
  if (values.yes && command !== 'sync') throw new Error('--yes is only supported by sync.');
  if (command === 'status' && (values.repo !== undefined || values.ref !== undefined || values.agent || values['dry-run'])) throw new Error('status reads local records. Use sync --dry-run to compare with the repository.');
  if (command === 'list' && (values.agent || values['dry-run'] || (!values.remote && (values.repo !== undefined || values.ref !== undefined)))) throw new Error('Use list for installed skills, or list --remote with an optional --repo and --ref.');
  return { command, ...values, dryRun: values['dry-run'] };
}

const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
const prompting = (opts) => !opts.yes && !opts.dryRun;
const scope = (ctx) => ctx.project ? `Project (${ctx.base})` : `Global (${ctx.base})`;
const editingConfig = (opts) => opts.edit || opts.repo !== undefined || opts.ref !== undefined || Boolean(opts.agent);

function requireTTY() {
  if (!interactive()) throw new Error('This operation needs a terminal. Use sync --yes to apply or --dry-run to preview; use config flags to save settings.');
}

function configure(config, opts) {
  const next = structuredClone(config);
  next.repo = opts.repo !== undefined ? normalizeRepo(opts.repo) : config.repo ? normalizeRepo(config.repo) : null;
  if (next.repo !== (config.repo ? normalizeRepo(config.repo) : null)) { next.ref = null; next.skills = null; }
  if (opts.ref !== undefined) next.ref = opts.ref === 'default' ? null : opts.ref;
  if (next.ref !== null && (!next.ref.trim() || next.ref.startsWith('-'))) throw new Error('The branch or tag must not be empty or start with a hyphen.');
  if (opts.agent) next.agents = opts.agent;
  return next;
}

async function askRepository(repo) {
  return input({ message: 'Skill repository (owner/repo, Git URL, or local Git path)', default: repo || undefined,
    validate: (value) => { try { normalizeRepo(value); return true; } catch (e) { return e.message; } } });
}

async function chooseAgents(agents) {
  return checkbox({ message: 'Target tools (Space to toggle, Enter to continue)',
    choices: Object.entries(AGENTS).map(([value, a]) => ({ name: a.label, value, checked: agents.includes(value) })),
    validate: (values) => values.length > 0 || 'Select at least one tool.', loop: false });
}

function selectedNames(config, state) {
  return config.skills ?? [...new Set(Object.values(state.installs)
    .filter((r) => !r.retired && r.repo === config.repo).map((r) => r.name))];
}

async function chooseSkills(skills, selected, state, config) {
  const installed = new Set(Object.values(state.installs).filter((r) => !r.retired && r.repo === config.repo).map((r) => r.name));
  return checkbox({
    message: 'Skills to install (Space to toggle, a to toggle all; unchecked installed skills will be removed)',
    choices: skills.map((skill) => ({ name: `${skill.name}${installed.has(skill.name) ? ' [Installed]' : ' [Available]'}`,
      value: skill.name, description: skill.description, checked: selected.includes(skill.name) })),
    pageSize: 12, loop: false,
  });
}

function header(ctx, config) {
  console.log(`\nScope   ${scope(ctx)}\nSource  ${config.repo || 'Not configured'}\nRef     ${config.ref || 'Default branch'}`);
  console.log(`Tools   ${config.agents.map((a) => AGENTS[a].label).join(', ')}`);
  for (const { root } of targets(ctx, config.agents)) console.log(`Target  ${root}`);
}

async function sync(ctx, opts) {
  const initial = await readConfig(ctx);
  const config = configure(initial, opts);
  const state = await readState(ctx);
  const configured = Boolean(await exists(ctx.configFile));
  if (prompting(opts) && !opts.agent) config.agents = await chooseAgents(config.agents);
  header(ctx, config);
  console.log('Fetching repository...');
  const repo = await checkout(config.repo, config.ref);
  try {
    // Fetch and validate the complete inventory before planning any deletion.
    const skills = await discover(repo.dir);
    const contents = new Map();
    for (const skill of skills) contents.set(skill.name, await snapshot(skill.dir));
    const names = new Set(skills.map((s) => s.name));
    if (opts.skill) for (const name of opts.skill) if (!names.has(name)) throw new Error(`Skill not found in repository: ${name}`);
    let selected = opts.all ? [...names] : opts.skill ?? selectedNames(config, state);
    if (prompting(opts) && !opts.skill && !opts.all && skills.length) selected = await chooseSkills(skills, selected, state, config);
    else if (!prompting(opts) && !opts.skill && !opts.all && config.skills === null && !selected.length && skills.length) {
      throw new Error('No saved skill selection. Run skillsm sync interactively, or pass --skill <name> or --all.');
    }
    config.skills = [...new Set(selected)].filter((name) => names.has(name)).sort();
    const wanted = skills.filter((s) => config.skills.includes(s.name));
    const plans = await planSync(ctx, wanted, contents, config, state);
    const counts = { install: 0, update: 0, replace: 0, remove: 0, unchanged: 0, conflict: 0 };
    console.log(`\n${opts.dryRun ? 'Preview' : 'Sync plan'} | ${repo.commit.slice(0, 12)} | ${config.skills.length} selected / ${skills.length} available skills`);
    if (skills.length && !config.skills.length) console.log('No skills selected. Previously managed skills will be removed.');
    if (!skills.length) console.log('Repository inventory is empty. Previously managed skills will be removed.');
    const labels = { install: 'Install', update: 'Update', replace: 'Replace', remove: 'Remove', conflict: 'Conflict' };
    for (const plan of plans) {
      counts[plan.action]++;
      if (plan.action !== 'unchanged') console.log(`  ${labels[plan.action]}  ${plan.skill.name} -> ${plan.dest}${plan.reason ? `\n    ${plan.reason}` : ''}`);
    }
    console.log(`\nPer target: install ${counts.install}, update ${counts.update}, replace ${counts.replace}, remove ${counts.remove}, unchanged ${counts.unchanged}, conflicts ${counts.conflict}.`);
    if (counts.remove || counts.replace) console.log('Only unchanged managed files are removed or replaced. Unmanaged files are kept.');
    if (counts.conflict) {
      console.log('Resolve conflicts before syncing. Nothing changed. Restore managed files or move the affected directory aside, then retry.');
      process.exitCode = 1; return;
    }
    if (opts.dryRun) { console.log('Preview only. Files, settings, and records were not changed.'); return; }
    const changed = counts.install + counts.update + counts.replace + counts.remove;
    const configChanged = !configured || JSON.stringify(config) !== JSON.stringify(initial);
    if (!changed) console.log('No file changes.');
    if (prompting(opts) && (changed || configChanged) && !await confirm({ message: 'Apply this sync and save settings?', default: true })) {
      console.log('Cancelled. Files and settings were not changed.'); return;
    }
    for (const plan of plans) {
      try {
        if (plan.action === 'remove') await removeInstall(ctx, plan.key, state);
        else await applyInstall(ctx, plan, config, state, repo.commit);
      } catch (e) { throw new Error(`Sync stopped at ${plan.dest}: ${e.message}. Earlier completed targets are kept; resolve the issue and rerun sync.`); }
    }
    // Save settings only after all targets succeeded. File ownership is saved per target.
    await writeJSON(ctx, ctx.configFile, config);
    console.log(`Synced to ${repo.commit.slice(0, 12)}.`);
  } finally { await repo.cleanup(); }
}

async function list(ctx, opts) {
  const config = configure(await readConfig(ctx), opts);
  const state = await readState(ctx);
  const records = Object.values(state.installs).filter((r) => !r.retired);
  header(ctx, config);
  if (!opts.remote) {
    console.log('\nInstalled skills:');
    for (const record of records) console.log(`  ${record.name}\n    ${path.join(targetRoot(ctx, record.agent), record.name)}\n    ${record.repo} @ ${record.commit.slice(0, 12)}`);
    if (!records.length) console.log('  None. Run skillsm sync to choose skills and tools.');
    console.log('\nUse skillsm list --remote to browse available skills, or skillsm status to check local files.');
    return;
  }
  if (!config.repo) throw new Error('No skill repository configured. Use skillsm list --remote --repo owner/repo or skillsm config --edit.');
  const repo = await checkout(config.repo, config.ref);
  try {
    const selected = new Set(selectedNames(config, state));
    const skills = await discover(repo.dir);
    console.log('\nAvailable skills ([x] selected, [ ] not selected):');
    for (const skill of skills) {
      const installed = records.some((r) => r.repo === config.repo && r.name === skill.name);
      console.log(`  [${selected.has(skill.name) ? 'x' : ' '}] ${skill.name}${installed ? ' [Installed]' : ''}\n    ${skill.description}`);
    }
    if (!skills.length) console.log('  No skills in this repository.');
  } finally { await repo.cleanup(); }
}

async function status(ctx) {
  const config = configure(await readConfig(ctx), {});
  const state = await readState(ctx);
  header(ctx, config);
  console.log('\nLocal status (compared with the last sync):');
  const roots = new Set(targets(ctx, config.agents).map((t) => t.root));
  let shown = 0;
  for (const record of Object.values(state.installs)) {
    const result = await inspectInstall(ctx, record);
    if (record.retired && result.status === 'Missing') continue;
    const root = targetRoot(ctx, record.agent);
    const pending = !record.retired && (record.repo !== config.repo || !roots.has(root) || record.ref !== config.ref || (config.skills !== null && !config.skills.includes(record.name)));
    console.log(`  ${result.status}  ${record.name}${pending ? '  [Configuration changed]' : ''}\n    ${path.join(root, record.name)}\n    ${record.repo} @ ${record.commit.slice(0, 12)}${result.reason ? `\n    ${result.reason}` : ''}`);
    shown++;
  }
  if (!shown) console.log('  No managed skills installed. Run skillsm sync to get started.');
  console.log('\nRun skillsm sync --dry-run to compare with the repository.');
}

async function configCommand(ctx, opts) {
  const initial = await readConfig(ctx);
  let config = configure(initial, opts);
  if (!editingConfig(opts)) {
    header(ctx, config);
    const local = Boolean(await exists(ctx.configFile));
    const inherited = !local && ctx.project && Boolean(await exists(context({ home: ctx.home }).configFile));
    console.log(`Config  ${ctx.configFile} (${local ? 'saved' : inherited ? 'inherited from global settings' : 'not saved; defaults'})`);
    console.log(`Skills  ${config.skills === null ? 'Not selected yet; existing managed skills will be preselected' : config.skills.length ? config.skills.join(', ') : 'None selected'}`);
    console.log('Run skillsm sync to change skill and tool selections.');
    console.log(`\nRun skillsm config${ctx.project ? ' --project' : ''} --edit to change settings.`);
    return;
  }
  if (opts.edit) {
    header(ctx, config);
    config = configure(config, { repo: await askRepository(config.repo) });
    const ref = await input({ message: 'Branch or tag (default follows the default branch)', default: config.ref || 'default',
      validate: (value) => value.trim() && !value.startsWith('-') || 'Enter a branch, tag, or default.' });
    config = configure(config, { ref, agent: await chooseAgents(config.agents) });
  }
  header(ctx, config);
  console.log('The next sync will let you choose skills and reconcile managed copies with the selection and targets, including removals.');
  if (opts.dryRun) { console.log('Preview only. Settings were not saved.'); return; }
  if (opts.edit && !await confirm({ message: 'Save these settings?', default: true })) { console.log('Cancelled. Settings were not changed.'); return; }
  await writeJSON(ctx, ctx.configFile, config);
  console.log(`Settings saved: ${ctx.configFile}\nRun skillsm sync --dry-run to preview the resulting changes.`);
}

export async function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (opts.help) { console.log(HELP); return; }
  if (opts.version) { console.log(JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version); return; }
  const ctx = context({ project: opts.project });
  if (!opts.command) {
    if (!interactive()) { console.log(HELP); return; }
    header(ctx, await readConfig(ctx));
    opts.command = await select({ message: 'What would you like to do?', choices: [
      { name: 'Choose tools and skills / sync', value: 'sync' },
      { name: 'List installed skills', value: 'list' }, { name: 'Browse repository skills', value: 'browse' }, { name: 'Local status', value: 'status' },
      { name: 'View settings', value: 'config' }, { name: 'Edit settings', value: 'edit' }, { name: 'Exit', value: 'exit' },
    ] });
    if (opts.command === 'exit') return;
    if (opts.command === 'browse') { opts.command = 'list'; opts.remote = true; }
    if (opts.command === 'edit') { opts.command = 'config'; opts.edit = true; }
  }
  if (opts.command === 'sync') {
    if (prompting(opts)) requireTTY();
    const config = configure(await readConfig(ctx), opts);
    if (!config.repo) {
      if (!prompting(opts)) throw new Error('No skill repository configured. Use skillsm sync --repo owner/repo or skillsm config --edit.');
      opts.repo = await askRepository(null);
    }
  }
  if (opts.edit) requireTTY();
  const action = () => opts.command === 'sync' ? sync(ctx, opts) : opts.command === 'list' ? list(ctx, opts) : opts.command === 'status' ? status(ctx) : configCommand(ctx, opts);
  if (opts.command === 'status' || opts.command === 'list' || (opts.command === 'config' && !editingConfig(opts)) || opts.dryRun) return action();
  return withLock(ctx, action);
}
