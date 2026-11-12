import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { context, readConfig, readState, withLock } from '../src/store.js';
import { checkout, discover, normalizeRepo, snapshot } from '../src/repository.js';
import { planInstall, applyInstall, removeInstall } from '../src/install.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/skillsm.js', import.meta.url));
const put = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const missing = async (file) => assert.rejects(fs.access(file), { code: 'ENOENT' });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsm-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const repo = path.join(root, 'repo');
  await Promise.all([home, cwd, repo].map((d) => fs.mkdir(d)));
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', NO_COLOR: '1' };
  const git = (...args) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Skillsm Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', repo, ...args], { env });
  await git('init', '-b', 'main');
  const skill = async (name, content = 'v1', prefix = 'skills') => {
    const dir = path.join(repo, prefix, name);
    await put(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} test skill\n---\n${content}\n`);
    return dir;
  };
  const alpha = await skill('alpha');
  await put(path.join(alpha, 'references', 'old.txt'), 'old');
  const beta = await skill('beta', 'v1', '.');
  const commit = async () => { await git('add', '.'); await git('commit', '-m', 'test(fixtures): update skill content'); };
  await commit();
  const run = async (...args) => {
    try { const result = await exec(process.execPath, [cli, ...args], { env, cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }); return { ...result, code: 0 }; }
    catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  };
  const sync = async (...args) => { const result = await run('sync', '--repo', repo, '--yes', ...(args.includes('--skill') ? [] : ['--all']), ...args); assert.equal(result.code, 0, result.stderr); return result; };
  const ctx = context({ home, cwd });
  const dest = (name = 'alpha', agent = '.agents', project = false) => path.join(project ? cwd : home, agent, 'skills', name);
  return { root, home, cwd, repo, env, git, skill, alpha, beta, commit, run, sync, ctx, dest };
}

test('explicit --all installs the entire repository to both defaults and skips unchanged files', async (t) => {
  const f = await fixture(t);
  await f.sync();
  for (const name of ['alpha', 'beta']) for (const agent of ['.agents', '.claude']) await fs.access(path.join(f.dest(name, agent), 'SKILL.md'));
  const before = await fs.stat(path.join(f.dest(), 'SKILL.md'));
  assert.deepEqual((await readConfig(f.ctx)).agents, ['codex', 'claude']);
  assert.equal(Object.keys((await readState(f.ctx)).installs).length, 4);
  const repeat = await f.run('sync', '--yes');
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.match(repeat.stdout, /unchanged 4/);
  assert.equal((await fs.stat(path.join(f.dest(), 'SKILL.md'))).mtimeMs, before.mtimeMs);
  await missing(path.join(f.cwd, '.agents'));
});

test('sync adds skills, updates files, removes obsolete managed files and preserves generated content', async (t) => {
  const f = await fixture(t);
  await f.sync();
  await put(path.join(f.dest(), 'outputs', 'render.txt'), 'generated');
  await put(path.join(f.dest(), 'node_modules', 'dependency.txt'), 'dependency');
  const outside = path.join(f.root, 'outside'); await put(path.join(outside, 'keep.txt'), 'outside');
  await fs.symlink(outside, path.join(f.dest(), 'runtime-link'));
  await f.skill('alpha', 'v2'); await f.skill('gamma');
  await fs.rm(path.join(f.alpha, 'references', 'old.txt'));
  await put(path.join(f.alpha, 'scripts', 'run.sh'), '#!/bin/sh\necho hello\n');
  await fs.chmod(path.join(f.alpha, 'scripts', 'run.sh'), 0o755); await f.commit();
  const result = await f.run('sync', '--all', '--yes');
  assert.equal(result.code, 0, result.stderr);
  assert.match(await fs.readFile(path.join(f.dest(), 'SKILL.md'), 'utf8'), /v2/);
  await fs.access(path.join(f.dest('gamma'), 'SKILL.md'));
  await missing(path.join(f.dest(), 'references', 'old.txt'));
  assert.equal(await fs.readFile(path.join(f.dest(), 'outputs', 'render.txt'), 'utf8'), 'generated');
  assert.equal(await fs.readlink(path.join(f.dest(), 'runtime-link')), outside);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside');
  assert.ok((await fs.stat(path.join(f.dest(), 'scripts', 'run.sh'))).mode & 0o111);
});

test('removing then re-adding a skill preserves generated files and directory ownership', async (t) => {
  const f = await fixture(t); await f.sync();
  await put(path.join(f.dest(), 'output.txt'), 'keep');
  await fs.rm(f.alpha, { recursive: true }); await f.commit();
  let result = await f.run('sync', '--all', '--yes');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /remove 2/);
  await missing(path.join(f.dest(), 'SKILL.md'));
  await missing(f.dest('alpha', '.claude'));
  assert.equal(await fs.readFile(path.join(f.dest(), 'output.txt'), 'utf8'), 'keep');
  assert.equal((await readState(f.ctx)).installs['.agents/skills/alpha'].retired, true);
  assert.match((await f.run('status')).stdout, /Preserved  alpha/);
  result = await f.run('sync', '--all', '--yes');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /remove 0/);
  await f.skill('alpha', 'v2'); await f.commit();
  result = await f.run('sync', '--all', '--yes');
  assert.equal(result.code, 0, result.stderr);
  assert.match(await fs.readFile(path.join(f.dest(), 'SKILL.md'), 'utf8'), /v2/);
  assert.equal(await fs.readFile(path.join(f.dest(), 'output.txt'), 'utf8'), 'keep');
  assert.equal((await readState(f.ctx)).installs['.agents/skills/alpha'].retired, undefined);
});

test('re-adding a skill cannot overwrite a preserved file with the same name', async (t) => {
  const f = await fixture(t); await f.sync();
  await put(path.join(f.dest(), 'output.txt'), 'keep');
  await fs.rm(f.alpha, { recursive: true }); await f.commit();
  assert.equal((await f.run('sync', '--all', '--yes')).code, 0);
  await f.skill('alpha', 'v2'); await put(path.join(f.alpha, 'output.txt'), 'upstream'); await f.commit();
  const result = await f.run('sync', '--all', '--yes');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /unmanaged local content/);
  assert.equal(await fs.readFile(path.join(f.dest(), 'output.txt'), 'utf8'), 'keep');
  await missing(f.dest('alpha', '.claude'));
});

test('an empty committed repository removes all managed skills and can later be populated again', async (t) => {
  const f = await fixture(t); await f.sync();
  await fs.rm(f.alpha, { recursive: true }); await fs.rm(f.beta, { recursive: true }); await f.commit();
  let result = await f.run('sync', '--all', '--yes');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /inventory is empty/);
  for (const name of ['alpha', 'beta']) for (const agent of ['.agents', '.claude']) await missing(f.dest(name, agent));
  assert.match((await f.run('status')).stdout, /No managed skills installed/);
  await f.skill('alpha'); await f.commit();
  result = await f.run('sync', '--all', '--yes');
  assert.equal(result.code, 0, result.stderr);
  await fs.access(path.join(f.dest(), 'SKILL.md'));
});

test('invalid metadata and failed fetches never turn into an empty-inventory deletion', async (t) => {
  const f = await fixture(t); await f.sync();
  const stateBefore = await fs.readFile(f.ctx.stateFile, 'utf8');
  const configBefore = await fs.readFile(f.ctx.configFile, 'utf8');
  await fs.rm(f.beta, { recursive: true });
  await put(path.join(f.alpha, 'SKILL.md'), 'invalid metadata'); await f.commit();
  for (const args of [[], ['--ref', 'missing-branch'], ['--repo', path.join(f.root, 'missing-repo')]]) {
    const result = await f.run('sync', '--yes', ...args);
    assert.equal(result.code, 1);
    await fs.access(path.join(f.dest('beta'), 'SKILL.md'));
    assert.equal(await fs.readFile(f.ctx.stateFile, 'utf8'), stateBefore);
    assert.equal(await fs.readFile(f.ctx.configFile, 'utf8'), configBefore);
  }
});

test('any planned conflict blocks the entire sync, including unrelated removals and other targets', async (t) => {
  const f = await fixture(t); await f.sync();
  const stateBefore = await fs.readFile(f.ctx.stateFile, 'utf8');
  await put(path.join(f.dest(), 'SKILL.md'), 'my edits');
  await f.skill('alpha', 'v2'); await fs.rm(f.beta, { recursive: true }); await f.commit();
  const result = await f.run('sync', '--yes');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Modified: SKILL.md/);
  assert.match(result.stdout, /Nothing changed/);
  assert.equal(await fs.readFile(path.join(f.dest(), 'SKILL.md'), 'utf8'), 'my edits');
  assert.match(await fs.readFile(path.join(f.dest('alpha', '.claude'), 'SKILL.md'), 'utf8'), /v1/);
  await fs.access(path.join(f.dest('beta'), 'SKILL.md'));
  assert.equal(await fs.readFile(f.ctx.stateFile, 'utf8'), stateBefore);
});

test('modified skills scheduled for removal remain intact', async (t) => {
  const f = await fixture(t); await f.sync();
  await put(path.join(f.dest(), 'SKILL.md'), 'local edits');
  await fs.rm(f.alpha, { recursive: true }); await f.commit();
  const result = await f.run('sync', '--yes');
  assert.equal(result.code, 1);
  assert.equal(await fs.readFile(path.join(f.dest(), 'SKILL.md'), 'utf8'), 'local edits');
  await fs.access(path.join(f.dest('alpha', '.claude'), 'SKILL.md'));
});

test('unmanaged directories block sync and are never adopted', async (t) => {
  const f = await fixture(t);
  await put(path.join(f.dest(), 'mine.txt'), 'mine');
  const result = await f.run('sync', '--repo', f.repo, '--all', '--yes');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /not managed by skillsm/);
  assert.equal(await fs.readFile(path.join(f.dest(), 'mine.txt'), 'utf8'), 'mine');
  await missing(f.dest('beta')); await missing(f.ctx.configFile); await missing(f.ctx.stateFile);
});

test('changing tools installs new targets and removes only managed files from old targets', async (t) => {
  const f = await fixture(t); await f.sync();
  await put(path.join(f.dest(), 'output.txt'), 'keep');
  const result = await f.run('sync', '--agent', 'antigravity', '--yes');
  assert.equal(result.code, 0, result.stderr);
  await fs.access(path.join(f.home, '.gemini/config/skills/alpha/SKILL.md'));
  await missing(path.join(f.dest(), 'SKILL.md')); await missing(f.dest('alpha', '.claude'));
  assert.equal(await fs.readFile(path.join(f.dest(), 'output.txt'), 'utf8'), 'keep');
  assert.deepEqual((await readConfig(f.ctx)).agents, ['antigravity']);
});

test('new-target conflicts prevent removal of the working old target', async (t) => {
  const f = await fixture(t); await f.sync('--agent', 'codex');
  await put(path.join(f.home, '.gemini/config/skills/alpha/SKILL.md'), 'unmanaged');
  const result = await f.run('sync', '--agent', 'antigravity', '--yes');
  assert.equal(result.code, 1);
  await fs.access(path.join(f.dest(), 'SKILL.md'));
  assert.deepEqual((await readConfig(f.ctx)).agents, ['codex']);
});

test('switching repository replaces same-named skills and removes old-only skills in one plan', async (t) => {
  const f = await fixture(t); await f.sync();
  const other = path.join(f.root, 'other');
  await exec('git', ['clone', '--quiet', f.repo, other], { env: f.env });
  await put(path.join(other, 'skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: New source\n---\nnew-source\n');
  await fs.rm(path.join(other, 'beta'), { recursive: true });
  await put(path.join(other, 'gamma/SKILL.md'), '---\nname: gamma\ndescription: New skill\n---\n');
  await exec('git', ['-C', other, 'add', '.'], { env: f.env });
  await exec('git', ['-C', other, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'new source'], { env: f.env });
  await put(path.join(f.dest(), 'output.txt'), 'keep');
  const preview = await f.run('sync', '--repo', other, '--all', '--dry-run');
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /Replace  alpha/); assert.match(preview.stdout, /Remove  beta/);
  assert.equal((await readConfig(f.ctx)).repo, f.repo);
  const result = await f.run('sync', '--repo', other, '--all', '--yes');
  assert.equal(result.code, 0, result.stderr);
  assert.match(await fs.readFile(path.join(f.dest(), 'SKILL.md'), 'utf8'), /new-source/);
  await missing(f.dest('beta')); await fs.access(path.join(f.dest('gamma'), 'SKILL.md'));
  assert.equal(await fs.readFile(path.join(f.dest(), 'output.txt'), 'utf8'), 'keep');
  assert.equal((await readState(f.ctx)).installs['.agents/skills/alpha'].repo, other);
});

test('project inherits settings, deduplicates shared directories and stays separate from global sync', async (t) => {
  const f = await fixture(t); await f.sync();
  const result = await f.run('sync', '--project', '--agent', 'codex', 'claude', 'antigravity', 'antigravity-cli', '--yes');
  assert.equal(result.code, 0, result.stderr);
  const project = context({ home: f.home, cwd: f.cwd, project: true });
  assert.equal(Object.keys((await readState(project)).installs).length, 4);
  await f.skill('alpha', 'v2'); await f.commit();
  assert.equal((await f.run('sync', '--yes')).code, 0);
  assert.match(await fs.readFile(path.join(f.dest('alpha', '.agents', true), 'SKILL.md'), 'utf8'), /v1/);
  const dedup = await f.run('sync', '--project', '--agent', 'antigravity', '--yes');
  assert.equal(dedup.code, 0, dedup.stderr);
  assert.match(await fs.readFile(path.join(f.dest('alpha', '.agents', true), 'SKILL.md'), 'utf8'), /v2/);
  await missing(f.dest('alpha', '.claude', true));
  await fs.access(path.join(f.dest('alpha', '.claude'), 'SKILL.md'));
});

test('previews write neither targets nor settings nor installation records or locks', async (t) => {
  const f = await fixture(t);
  const first = await f.run('sync', '--repo', f.repo, '--all', '--dry-run');
  assert.equal(first.code, 0, first.stderr); assert.deepEqual(await fs.readdir(f.home), []);
  await f.sync();
  const stateBefore = await fs.readFile(f.ctx.stateFile, 'utf8');
  const configBefore = await fs.readFile(f.ctx.configFile, 'utf8');
  await fs.rm(f.beta, { recursive: true }); await f.commit();
  const result = await f.run('sync', '--agent', 'antigravity', '--dry-run');
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Remove/);
  assert.equal(await fs.readFile(f.ctx.stateFile, 'utf8'), stateBefore);
  assert.equal(await fs.readFile(f.ctx.configFile, 'utf8'), configBefore);
  await fs.access(path.join(f.dest('beta'), 'SKILL.md'));
  await missing(path.join(f.ctx.dir, 'lock')); await missing(path.join(f.home, '.gemini'));
});

test('status inspects local modifications and missing files without fetching the repository', async (t) => {
  const f = await fixture(t); await f.sync();
  assert.match((await f.run('status')).stdout, /Clean  alpha/);
  await put(path.join(f.dest(), 'SKILL.md'), 'edited');
  await fs.rm(path.join(f.dest('beta'), 'SKILL.md'));
  await fs.rm(f.repo, { recursive: true });
  const stateBefore = await fs.readFile(f.ctx.stateFile, 'utf8');
  const result = await f.run('status');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Modified  alpha/); assert.match(result.stdout, /Missing  beta/);
  assert.equal(await fs.readFile(f.ctx.stateFile, 'utf8'), stateBefore);
  await missing(path.join(f.ctx.dir, 'lock'));
});

test('a missing directory is restored, but a partially missing managed skill conflicts', async (t) => {
  const f = await fixture(t); await f.sync();
  await fs.rm(f.dest(), { recursive: true });
  assert.equal((await f.run('sync', '--yes')).code, 0);
  await fs.access(path.join(f.dest(), 'SKILL.md'));
  await fs.rm(path.join(f.dest(), 'references/old.txt'));
  const result = await f.run('sync', '--yes');
  assert.equal(result.code, 1); assert.match(result.stdout, /Missing: references\/old.txt/);
});

test('destination symlinks and symlinked managed parents cannot redirect sync writes or removals', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.mkdir(path.dirname(f.dest()), { recursive: true }); await fs.symlink(outside, f.dest());
  assert.equal((await f.run('sync', '--repo', f.repo, '--all', '--yes')).code, 1);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(f.dest()); await f.sync();
  await fs.rm(path.join(f.dest(), 'references'), { recursive: true });
  await fs.symlink(outside, path.join(f.dest(), 'references'));
  await fs.rm(f.alpha, { recursive: true }); await f.commit();
  const result = await f.run('sync', '--yes');
  assert.equal(result.code, 1); assert.match(result.stdout, /symlink/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('source symlinks, duplicate names and malformed metadata fail before deletion', async (t) => {
  const f = await fixture(t); await f.sync();
  await fs.rm(f.beta, { recursive: true });
  await fs.symlink('/etc/passwd', path.join(f.alpha, 'unsafe.txt')); await f.commit();
  assert.equal((await f.run('sync', '--yes')).code, 1);
  await fs.access(path.join(f.dest('beta'), 'SKILL.md'));
  await fs.rm(path.join(f.alpha, 'unsafe.txt'));
  await put(path.join(f.repo, 'duplicate/SKILL.md'), '---\nname: alpha\ndescription: duplicate\n---\n');
  await assert.rejects(discover(f.repo), /Duplicate skill name/);
  await fs.rm(path.join(f.repo, 'duplicate'), { recursive: true });
  await put(path.join(f.alpha, 'SKILL.md'), '---\nname: ../../escape\ndescription: unsafe\n---\n');
  await assert.rejects(discover(f.repo), /valid name/);
});

test('discovery ignores local agent aliases and runtime dependencies', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.repo, '.agents/skills'), { recursive: true });
  await fs.symlink('../../skills/alpha', path.join(f.repo, '.agents/skills/alpha'));
  await f.skill('dependency', 'v1', 'node_modules');
  assert.deepEqual((await discover(f.repo)).map((s) => s.name), ['alpha', 'beta']);
});

test('failed state persistence rolls back replacements and removals', async (t) => {
  const f = await fixture(t); await f.sync(); await f.skill('alpha', 'v2'); await f.commit();
  const repo = await checkout(f.repo, null);
  try {
    const skill = (await discover(repo.dir)).find((s) => s.name === 'alpha');
    const state = await readState(f.ctx), config = await readConfig(f.ctx);
    const plan = await planInstall(f.ctx, skill, 'codex', config, state, await snapshot(skill.dir));
    await fs.rm(f.ctx.stateFile); await fs.mkdir(f.ctx.stateFile);
    await assert.rejects(applyInstall(f.ctx, plan, config, state, repo.commit));
    assert.match(await fs.readFile(path.join(f.dest(), 'SKILL.md'), 'utf8'), /v1/);
    await assert.rejects(removeInstall(f.ctx, '.agents/skills/alpha', state));
    assert.match(await fs.readFile(path.join(f.dest(), 'SKILL.md'), 'utf8'), /v1/);
    assert.equal(state.installs['.agents/skills/alpha'].retired, undefined);
    assert.equal((await fs.readdir(path.dirname(f.dest()))).some((p) => p.includes('stage') || p.includes('backup')), false);
  } finally { await repo.cleanup(); }
});

test('local edits after planning are rechecked before mutation', async (t) => {
  const f = await fixture(t); await f.sync(); await f.skill('alpha', 'v2'); await f.commit();
  const repo = await checkout(f.repo, null);
  try {
    const skill = (await discover(repo.dir)).find((s) => s.name === 'alpha');
    const state = await readState(f.ctx), config = await readConfig(f.ctx);
    const plan = await planInstall(f.ctx, skill, 'codex', config, state, await snapshot(skill.dir));
    await put(path.join(f.dest(), 'SKILL.md'), 'late edit');
    await assert.rejects(applyInstall(f.ctx, plan, config, state, repo.commit), /Modified/);
    await assert.rejects(removeInstall(f.ctx, '.agents/skills/alpha', state), /Modified/);
    assert.equal(await fs.readFile(path.join(f.dest(), 'SKILL.md'), 'utf8'), 'late edit');
  } finally { await repo.cleanup(); }
});

test('scope lock rejects concurrent syncs and releases after errors', async (t) => {
  const f = await fixture(t);
  await withLock(f.ctx, async () => {
    const result = await f.run('sync', '--repo', f.repo, '--all', '--yes');
    assert.equal(result.code, 1); assert.match(result.stderr, /Another operation holds/);
  });
  await assert.rejects(withLock(f.ctx, async () => { throw new Error('test'); }), /test/);
  await missing(path.join(f.ctx.dir, 'lock'));
});

test('fresh read-only commands and missing-source errors do not create configuration', async (t) => {
  const f = await fixture(t);
  assert.equal((await readConfig(f.ctx)).repo, null);
  for (const args of [['config'], ['config', '--project'], ['list'], ['status'], [], ['--help'], ['--version']]) {
    const result = await f.run(...args); assert.equal(result.code, 0, result.stderr);
  }
  for (const args of [['sync', '--yes'], ['sync', '--dry-run']]) {
    const result = await f.run(...args); assert.equal(result.code, 1); assert.match(result.stderr, /No skill repository configured/);
  }
  assert.deepEqual(await fs.readdir(f.home), []); assert.deepEqual(await fs.readdir(f.cwd), []);
});

test('settings are viewable, editable and previewable; saving does not change installations', async (t) => {
  const f = await fixture(t);
  let result = await f.run('config', '--repo', f.repo, '--ref', 'release', '--agent', 'codex');
  assert.equal(result.code, 0, result.stderr); await missing(f.ctx.stateFile);
  const before = await fs.readFile(f.ctx.configFile, 'utf8');
  await withLock(f.ctx, async () => { assert.equal((await f.run('config')).code, 0); });
  result = await f.run('config', '--repo', 'example/other', '--dry-run');
  assert.equal(result.code, 0, result.stderr); assert.equal(await fs.readFile(f.ctx.configFile, 'utf8'), before);
  await f.run('config', '--ref', 'default');
  assert.equal((await f.run('sync', '--all', '--yes')).code, 0);
  result = await f.run('config', '--repo', 'example/other');
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await readConfig(f.ctx)).ref, null);
  await fs.access(path.join(f.dest(), 'SKILL.md'));
  assert.match((await f.run('status')).stdout, /Configuration changed/);
});

test('project settings inherit until saved and remain isolated afterward', async (t) => {
  const f = await fixture(t);
  await f.run('config', '--repo', f.repo, '--agent', 'claude');
  const before = await fs.readFile(f.ctx.configFile, 'utf8');
  assert.match((await f.run('config', '--project')).stdout, /inherited from global settings/);
  const project = context({ home: f.home, cwd: f.cwd, project: true }); await missing(project.dir);
  assert.equal((await f.run('config', '--project', '--repo', 'example/project', '--agent', 'codex')).code, 0);
  assert.equal((await readConfig(project)).repo, 'https://github.com/example/project.git');
  assert.equal(await fs.readFile(f.ctx.configFile, 'utf8'), before);
});

test('invalid arguments, old commands and conflicting selection flags fail without changing home', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['install'], ['update'], ['remove'], ['sync', '--skill', 'alpha', '--all'], ['sync', '--skill'], ['list', '--skill', 'alpha'],
    ['sync', '--agent', 'typo', '--yes'], ['sync', '--repo', f.repo], ['config', '--edit'],
    ['config', '--edit', '--dry-run'], ['config', '--repo', ''], ['config', '--ref', ' '],
    ['status', '--repo', f.repo], ['status', '--yes'], ['status', '--dry-run'],
  ]) assert.equal((await f.run(...args)).code, 1, args.join(' '));
  await missing(f.ctx.configFile); await missing(f.ctx.stateFile);
  assert.equal(normalizeRepo('example/skills'), 'https://github.com/example/skills.git');
  assert.throws(() => normalizeRepo('https://secret@example.com/repo'), /credentials/);
  assert.throws(() => normalizeRepo('--upload-pack=bad'), /Repository must be/);
});

test('a saved subset installs only selected skills and never automatically selects new ones', async (t) => {
  const f = await fixture(t);
  await f.sync('--skill', 'alpha', '--agent', 'codex');
  assert.deepEqual((await readConfig(f.ctx)).skills, ['alpha']);
  await missing(f.dest('beta')); await missing(f.dest('alpha', '.claude'));
  await f.skill('gamma'); await f.skill('alpha', 'v2'); await f.commit();
  const result = await f.run('sync', '--yes');
  assert.equal(result.code, 0, result.stderr);
  assert.match(await fs.readFile(path.join(f.dest(), 'SKILL.md'), 'utf8'), /v2/);
  await missing(f.dest('beta')); await missing(f.dest('gamma'));
  assert.deepEqual((await readConfig(f.ctx)).skills, ['alpha']);
});

test('changing the selection previews removal, preserves outputs, and permits reselection', async (t) => {
  const f = await fixture(t); await f.sync();
  await put(path.join(f.dest('beta'), 'output.txt'), 'keep');
  const preview = await f.run('sync', '--skill', 'alpha', '--dry-run');
  assert.equal(preview.code, 0, preview.stderr); assert.match(preview.stdout, /Remove  beta/);
  assert.deepEqual((await readConfig(f.ctx)).skills, ['alpha', 'beta']);
  await fs.access(path.join(f.dest('beta'), 'SKILL.md'));
  const removed = await f.run('sync', '--skill', 'alpha', '--yes');
  assert.equal(removed.code, 0, removed.stderr);
  await missing(path.join(f.dest('beta'), 'SKILL.md'));
  assert.equal(await fs.readFile(path.join(f.dest('beta'), 'output.txt'), 'utf8'), 'keep');
  assert.deepEqual((await readConfig(f.ctx)).skills, ['alpha']);
  const added = await f.run('sync', '--skill', 'alpha', 'beta', '--yes');
  assert.equal(added.code, 0, added.stderr); await fs.access(path.join(f.dest('beta'), 'SKILL.md'));
  assert.equal(await fs.readFile(path.join(f.dest('beta'), 'output.txt'), 'utf8'), 'keep');
});

test('deselecting an edited skill conflicts and keeps the prior selection and all targets', async (t) => {
  const f = await fixture(t); await f.sync();
  await put(path.join(f.dest('beta'), 'SKILL.md'), 'local edits');
  const result = await f.run('sync', '--skill', 'alpha', '--yes');
  assert.equal(result.code, 1);
  assert.deepEqual((await readConfig(f.ctx)).skills, ['alpha', 'beta']);
  await fs.access(path.join(f.dest('beta', '.claude'), 'SKILL.md'));
  assert.equal(await fs.readFile(path.join(f.dest('beta'), 'SKILL.md'), 'utf8'), 'local edits');
});

test('installed and remote lists distinguish available, selected, and installed skills without writes', async (t) => {
  const f = await fixture(t); await f.sync('--skill', 'alpha');
  const before = await fs.readFile(f.ctx.configFile, 'utf8');
  const stateBefore = await fs.readFile(f.ctx.stateFile, 'utf8');
  const installed = await f.run('list');
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(installed.stdout, /Installed skills:/); assert.doesNotMatch(installed.stdout, /beta/);
  const available = await f.run('list', '--remote');
  assert.equal(available.code, 0, available.stderr);
  assert.match(available.stdout, /\[x\] alpha \[Installed\]/); assert.match(available.stdout, /\[ \] beta/);
  assert.equal(await fs.readFile(f.ctx.configFile, 'utf8'), before);
  assert.equal(await fs.readFile(f.ctx.stateFile, 'utf8'), stateBefore);
  await missing(path.join(f.ctx.dir, 'lock'));
  await fs.rm(f.repo, { recursive: true });
  assert.equal((await f.run('list')).code, 0);
});

test('fresh remote browsing needs no selection and saves no settings', async (t) => {
  const f = await fixture(t);
  const result = await f.run('list', '--remote', '--repo', f.repo);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /\[ \] alpha/);
  assert.deepEqual(await fs.readdir(f.home), []);
  const missingSource = await f.run('list', '--remote');
  assert.equal(missingSource.code, 1); assert.match(missingSource.stderr, /No skill repository/);
});

test('fresh scripts require an explicit selection and invalid names never remove existing skills', async (t) => {
  const f = await fixture(t);
  for (const flag of ['--yes', '--dry-run']) {
    const result = await f.run('sync', '--repo', f.repo, flag);
    assert.equal(result.code, 1); assert.match(result.stderr, /No saved skill selection/);
    await missing(f.ctx.configFile); await missing(f.ctx.stateFile);
  }
  await f.sync();
  const result = await f.run('sync', '--skill', 'missing-skill', '--yes');
  assert.equal(result.code, 1); assert.match(result.stderr, /Skill not found/);
  await fs.access(path.join(f.dest('alpha'), 'SKILL.md')); await fs.access(path.join(f.dest('beta'), 'SKILL.md'));
  assert.deepEqual((await readConfig(f.ctx)).skills, ['alpha', 'beta']);
});

test('old full-sync records preselect installed skills without silently installing new ones', async (t) => {
  const f = await fixture(t); await f.sync();
  const config = await readConfig(f.ctx); delete config.skills; await put(f.ctx.configFile, JSON.stringify(config));
  await f.skill('gamma'); await f.commit();
  const result = await f.run('sync', '--yes');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readConfig(f.ctx)).skills, ['alpha', 'beta']); await missing(f.dest('gamma'));
});

test('an empty saved selection is honored and is distinct from an unconfigured selection', async (t) => {
  const f = await fixture(t); await f.sync();
  const config = await readConfig(f.ctx); config.skills = []; await put(f.ctx.configFile, JSON.stringify(config));
  const result = await f.run('sync', '--yes');
  assert.equal(result.code, 0, result.stderr); await missing(f.dest()); await missing(f.dest('beta'));
  await f.skill('gamma'); await f.commit();
  assert.equal((await f.run('sync', '--yes')).code, 0); await missing(f.dest('gamma'));
});
