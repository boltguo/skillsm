import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exists, assertSafe, recordKey, targetRoot, targets, writeJSON } from './store.js';
import { fingerprint, sameFile, sameFiles } from './repository.js';

export async function inspectInstall(ctx, record) {
  const dest = path.join(targetRoot(ctx, record.agent), record.name);
  try {
    await assertSafe(ctx, dest);
    const stat = await exists(dest);
    if (!stat) return { status: 'Missing', reason: 'Directory is missing' };
    if (!stat.isDirectory()) return { status: 'Conflict', reason: 'Destination is not a directory' };
    if (record.retired) return { status: 'Preserved', reason: 'Skill removed; unmanaged files kept' };
    const missing = [], modified = [];
    for (const [file, expected] of Object.entries(record.files)) {
      const full = path.join(dest, file);
      await assertSafe(ctx, full);
      const current = await exists(full);
      if (!current) missing.push(file);
      else if (!sameFile(await fingerprint(full), expected)) modified.push(file);
    }
    const reasons = [];
    if (modified.length) reasons.push(`Modified: ${modified.join(', ')}`);
    if (missing.length) reasons.push(`Missing: ${missing.join(', ')}`);
    return { status: modified.length ? 'Modified' : missing.length ? 'Missing' : 'Clean', reason: reasons.join('; ') };
  } catch (e) { return { status: 'Conflict', reason: e.message }; }
}

async function verifyManaged(ctx, record) {
  const result = await inspectInstall(ctx, record);
  if (!['Clean', 'Preserved'].includes(result.status)) throw new Error(result.reason);
}

export async function planInstall(ctx, skill, agent, config, state, files) {
  const key = recordKey(ctx, agent, skill.name);
  const record = state.installs[key];
  const dest = path.join(targetRoot(ctx, agent), skill.name);
  const plan = { key, dest, agent, skill, files, record, action: 'install' };
  try {
    await assertSafe(ctx, dest);
    const stat = await exists(dest);
    if (stat && !record) throw new Error('Destination already exists and is not managed by skillsm');
    if (stat && !stat.isDirectory()) throw new Error('Destination is not a directory');
    if (stat && record) {
      await verifyManaged(ctx, record);
      for (const file of Object.keys(files)) {
        const full = path.join(dest, file);
        await assertSafe(ctx, full);
        if (!Object.hasOwn(record.files, file) && await exists(full)) throw new Error(`New file conflicts with unmanaged local content: ${file}`);
      }
      if (!record.retired) plan.action = sameFiles(files, record.files) ? 'unchanged' : 'update';
    }
    if (record && !record.retired && record.repo !== config.repo) {
      plan.action = 'replace';
      plan.reason = `Source changed: ${record.repo} -> ${config.repo}`;
    }
  } catch (e) { plan.action = 'conflict'; plan.reason = e.message; }
  return plan;
}

export async function planSync(ctx, skills, contents, config, state) {
  const plans = [], desired = new Set();
  const destinations = targets(ctx, config.agents);
  for (const skill of skills) {
    for (const { agent } of destinations) {
      const plan = await planInstall(ctx, skill, agent, config, state, contents.get(skill.name));
      plans.push(plan); desired.add(plan.key);
    }
  }
  // Install or replace desired skills before cleaning old sources and targets.
  for (const [key, record] of Object.entries(state.installs)) {
    if (record.retired || desired.has(key)) continue;
    const dest = path.join(targetRoot(ctx, record.agent), record.name);
    const plan = { key, dest, agent: record.agent, skill: { name: record.name }, record, action: 'remove',
      reason: 'No longer selected, no longer in the repository, or on a deselected target' };
    try { await removeInstall(ctx, key, state, true); }
    catch (e) { plan.action = 'conflict'; plan.reason = e.message; }
    plans.push(plan);
  }
  return plans;
}

async function pruneEmpty(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = path.join(dir, entry.name);
      await pruneEmpty(child);
      if (!(await fs.readdir(child)).length) await fs.rmdir(child);
    }
  }
}

// Swap only after staging succeeds. Restore the previous directory if saving state fails.
async function swap(dest, stage, commit) {
  const backup = `${dest}.skillsm-backup-${randomUUID()}`;
  const hadPrevious = Boolean(await exists(dest));
  if (hadPrevious) await fs.rename(dest, backup);
  let placed = false;
  try {
    await fs.rename(stage, dest);
    placed = true;
    await commit();
  } catch (error) {
    if (placed) await fs.rm(dest, { recursive: true, force: true });
    if (hadPrevious) await fs.rename(backup, dest);
    throw error;
  }
  if (hadPrevious) {
    try { await fs.rm(backup, { recursive: true, force: true }); }
    catch { console.warn(`Sync succeeded, but the old backup could not be removed: ${backup}`); }
  }
}

async function saveRecord(ctx, state, key, record) {
  const next = { ...state.installs, [key]: record };
  await writeJSON(ctx, ctx.stateFile, { version: 1, installs: next });
  state.installs = next;
}

export async function applyInstall(ctx, plan, config, state, commit) {
  const fresh = await planInstall(ctx, plan.skill, plan.agent, config, state, plan.files);
  if (fresh.action === 'conflict') throw new Error(fresh.reason);
  const record = { name: plan.skill.name, agent: plan.agent, repo: config.repo, ref: config.ref, commit, files: plan.files };
  const save = () => saveRecord(ctx, state, plan.key, record);
  if (fresh.action === 'unchanged') {
    if (JSON.stringify(fresh.record) !== JSON.stringify(record)) await save();
    return;
  }
  await assertSafe(ctx, plan.dest);
  await fs.mkdir(path.dirname(plan.dest), { recursive: true });
  const stage = await fs.mkdtemp(path.join(path.dirname(plan.dest), '.skillsm-stage-'));
  try {
    if (await exists(plan.dest)) {
      await fs.cp(plan.dest, stage, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      for (const file of Object.keys(fresh.record.files)) await fs.rm(path.join(stage, file));
      await pruneEmpty(stage);
    }
    for (const [file, meta] of Object.entries(plan.files)) {
      const output = path.join(stage, file);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(path.join(plan.skill.dir, file), output);
      await fs.chmod(output, meta.executable ? 0o755 : 0o644);
    }
    const recheck = await planInstall(ctx, plan.skill, plan.agent, config, state, plan.files);
    if (recheck.action === 'conflict') throw new Error(recheck.reason);
    await swap(plan.dest, stage, save);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

export async function removeInstall(ctx, key, state, dryRun = false) {
  const record = state.installs[key];
  if (record.retired) return;
  const dest = path.join(targetRoot(ctx, record.agent), record.name);
  await assertSafe(ctx, dest);
  const stat = await exists(dest);
  if (stat) await verifyManaged(ctx, record);
  if (dryRun) return;
  // Retain directory ownership, but no ownership of generated files. This permits
  // safe reinstallation without adopting unrelated files left in the directory.
  const save = () => saveRecord(ctx, state, key, { ...record, files: {}, retired: true });
  if (!stat) { await save(); return; }
  const stage = await fs.mkdtemp(path.join(path.dirname(dest), '.skillsm-stage-'));
  try {
    await fs.cp(dest, stage, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    for (const file of Object.keys(record.files)) await fs.rm(path.join(stage, file));
    await pruneEmpty(stage);
    await verifyManaged(ctx, record);
    await swap(dest, stage, save);
    if (!(await fs.readdir(dest)).length) await fs.rmdir(dest);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
