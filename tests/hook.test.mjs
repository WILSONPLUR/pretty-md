import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { checkPlanDelivery, completedPlan, rememberRender } from '../hooks/plan-delivery.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const hook = join(root, 'hooks', 'markdown-write.mjs');

function runHook(mode, cwd, pluginData, payload = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [hook, mode], {
      cwd,
      env: { ...process.env, PLUGIN_DATA: pluginData },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ cwd, ...payload }));
  });
}

test('hook snapshots quietly, then reports only created or changed Markdown files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pretty-md-hook-project-'));
  const pluginData = await mkdtemp(join(tmpdir(), 'pretty-md-hook-data-'));
  await writeFile(join(cwd, 'README.md'), '# Existing\n');
  await writeFile(join(cwd, 'notes.txt'), 'plain text\n');

  const baseline = await runHook('snapshot', cwd, pluginData);
  assert.equal(baseline.code, 0);
  assert.equal(baseline.stdout, '');

  await writeFile(join(cwd, 'README.md'), '# Updated\n');
  await writeFile(join(cwd, 'PLAN.markdown'), '# Plan\n');
  await writeFile(join(cwd, 'notes.txt'), 'changed\n');

  const detected = await runHook('detect', cwd, pluginData, { tool_name: 'apply_patch' });
  assert.equal(detected.code, 0, detected.stderr);
  const output = JSON.parse(detected.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /README\.md/);
  assert.match(output.hookSpecificOutput.additionalContext, /PLAN\.markdown/);
  assert.match(output.hookSpecificOutput.additionalContext, /pretty_md_render/);
  assert.match(output.hookSpecificOutput.additionalContext, /\[Open in Pretty MD\]\(viewUrl\)/);
  assert.match(output.hookSpecificOutput.additionalContext, /even when the panel opens/);
  assert.match(output.hookSpecificOutput.additionalContext, /expires in 24 hours/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /notes\.txt/);

  const unchanged = await runHook('detect', cwd, pluginData, { tool_name: 'Bash' });
  assert.equal(unchanged.code, 0);
  assert.equal(unchanged.stdout, '');
});

test('hook ignores generated dependency trees and initializes safely without a session snapshot', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pretty-md-hook-project-'));
  const pluginData = await mkdtemp(join(tmpdir(), 'pretty-md-hook-data-'));
  await mkdir(join(cwd, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(cwd, 'node_modules', 'pkg', 'README.md'), '# Dependency\n');
  await writeFile(join(cwd, 'DOC.mkd'), '# First observation\n');

  const first = await runHook('detect', cwd, pluginData, { tool_name: 'Bash' });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, '');

  await writeFile(join(cwd, 'DOC.mkd'), '# Changed later\n');
  const changed = await runHook('detect', cwd, pluginData, { tool_name: 'Bash' });
  assert.match(JSON.parse(changed.stdout).hookSpecificOutput.additionalContext, /DOC\.mkd/);
  assert.doesNotMatch(changed.stdout, /node_modules/);
});

test('plugin manifests wire trusted lifecycle events to the packaged hook', async () => {
  const hooks = JSON.parse(await readFile(join(root, 'hooks', 'hooks.json'), 'utf8'));
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /markdown-write\.mjs" snapshot$/);
  assert.equal(hooks.hooks.PostToolUse[0].matcher, '.*');
  assert.equal(hooks.hooks.Stop[0].hooks[0].command.includes('markdown-write.mjs\" stop'), true);
  assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /markdown-write\.mjs" prompt$/);

  const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'pretty-md');
  assert.equal(manifest.extensions['com.openai'].interface.logo, './assets/logo.svg');
  assert.equal(manifest.extensions['com.openai'].interface.composerIcon, './assets/logo.svg');
  const icon = await readFile(join(root, 'assets', 'logo.svg'), 'utf8');
  assert.match(icon, /viewBox="0 0 512 512"/);
  assert.ok(Buffer.byteLength(icon) <= 5 * 1024 * 1024);
  assert.equal(manifest.version, '0.4.10');
  assert.equal(manifest.extensions['com.openai'].hooks, './hooks/hooks.json');
  assert.match(manifest.description, /requested lists, guides, checklists/i);
  assert.match(manifest.description, /Plan.mode/i);
  assert.equal(manifest.extensions['com.openai'].interface.shortDescription, 'Cozy Markdown & plan reader');
  assert.ok(manifest.extensions['com.openai'].interface.shortDescription.length <= 30);
  assert.match(manifest.extensions['com.openai'].interface.defaultPrompt, /completed Plan-mode plan/i);
  assert.match(manifest.extensions['com.openai'].interface.defaultPrompt, /requested lists, guides, checklists/i);

  const skill = await readFile(join(root, 'skills', 'pretty-md', 'SKILL.md'), 'utf8');
  assert.match(skill, /Use this whenever a user asks to create, write, generate/i);
  assert.match(skill, /Do not wait for `@pretty-md`/);
  assert.match(skill, /normal ChatGPT file attachment or download link is not a substitute/i);
  assert.match(skill, /Always include `\[Open in Pretty MD\]\(viewUrl\)`/);
  assert.match(skill, /queued `open_in_codex`/);
  assert.match(skill, /Plan mode.*without.*file/i);
  assert.match(skill, /outside.*`<proposed_plan>`/i);
  const planSkill = await readFile(join(root, 'skills', 'plan-reader', 'SKILL.md'), 'utf8');
  assert.match(planSkill, /projectless Codex Remote/i);
  assert.match(planSkill, /filename: "plan.md"/i);

  const mcp = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers['pretty-md'].type, 'streamable-http');
  assert.equal(mcp.mcpServers['pretty-md'].url, 'https://pretty-md.yourshows12.chatgpt.site/mcp');
});

test('Stop catches missed Markdown writes and clears only the exact successfully rendered file', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pretty-md-hook-project-'));
  const pluginData = await mkdtemp(join(tmpdir(), 'pretty-md-hook-data-'));
  await runHook('snapshot', cwd, pluginData, { session_id: 'session-a' });
  await writeFile(join(cwd, 'PLAN.md'), '# Plan A\n');
  await writeFile(join(cwd, 'README.md'), '# Readme A\n');

  const missed = await runHook('stop', cwd, pluginData, { session_id: 'session-a', turn_id: 'turn-a' });
  const blocked = JSON.parse(missed.stdout);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /\[Open in Pretty MD\]\(viewUrl\)/);
  assert.match(blocked.reason, /even when panels open/);
  assert.match(blocked.reason, /PLAN\.md/);
  assert.match(blocked.reason, /README\.md/);

  await runHook('detect', cwd, pluginData, {
    session_id: 'session-a', tool_name: 'mcp__codex_apps__pretty_md_pretty_md_render',
    tool_input: { markdown: '# wrong\n', filename: 'PLAN.md' },
    tool_response: { isError: false, structuredContent: { viewUrl: 'https://example.test/view/id' } },
  });
  const stillPending = await runHook('stop', cwd, pluginData, { session_id: 'session-a', turn_id: 'turn-b' });
  assert.match(JSON.parse(stillPending.stdout).reason, /PLAN\.md/);

  await runHook('detect', cwd, pluginData, {
    session_id: 'session-a', tool_name: 'mcp__codex_apps__pretty_md_pretty_md_render',
    tool_input: { markdown: '# Plan A\n', filename: 'PLAN.md' },
    tool_response: { isError: false, structuredContent: { viewUrl: 'https://example.test/view/id' } },
  });
  const remaining = await runHook('stop', cwd, pluginData, { session_id: 'session-a', turn_id: 'turn-c' });
  assert.match(JSON.parse(remaining.stdout).reason, /README\.md/);
  assert.doesNotMatch(remaining.stdout, /PLAN\.md/);

  await runHook('detect', cwd, pluginData, {
    session_id: 'session-a', tool_name: 'mcp__codex_apps__pretty_md_pretty_md_render',
    tool_input: { markdown: '# Readme A\n', filename: 'README.md' },
    tool_response: { isError: false, structuredContent: { viewUrl: 'https://example.test/view/id' } },
  });
  assert.equal((await runHook('stop', cwd, pluginData, { session_id: 'session-a', turn_id: 'turn-d' })).stdout, '');
});

test('a later unrelated user turn cancels an undelivered plan recovery', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pretty-md-hook-project-'));
  const pluginData = await mkdtemp(join(tmpdir(), 'pretty-md-hook-data-'));
  const plan = '<proposed_plan>\n# Plan\n\n- Read source\n- Verify changes\n</proposed_plan>';
  const first = await runHook('stop', cwd, pluginData, { session_id: 'same-chat', turn_id: 'plan-turn', last_assistant_message: plan });
  assert.equal(JSON.parse(first.stdout).decision, 'block');
  const later = await runHook('stop', cwd, pluginData, { session_id: 'same-chat', turn_id: 'new-turn', last_assistant_message: 'The answer is 42.' });
  assert.equal(later.stdout, '');
});

test('renamed Markdown opens once under its current name', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pretty-md-hook-project-'));
  const pluginData = await mkdtemp(join(tmpdir(), 'pretty-md-hook-data-'));
  await writeFile(join(cwd, 'OLD.md'), '# Moved\n');
  await runHook('snapshot', cwd, pluginData);
  await rename(join(cwd, 'OLD.md'), join(cwd, 'NEW.md'));
  const detected = await runHook('detect', cwd, pluginData, { tool_name: 'Bash' });
  assert.match(detected.stdout, /NEW\.md/);
  assert.doesNotMatch(detected.stdout, /OLD\.md/);
  assert.equal((await runHook('detect', cwd, pluginData, { tool_name: 'Bash' })).stdout, '');
});

test('explicit Markdown output outside the workspace remains pending until exact content renders', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pretty-md-hook-project-'));
  const output = await mkdtemp(join(tmpdir(), 'pretty-md-hook-output-'));
  const pluginData = await mkdtemp(join(tmpdir(), 'pretty-md-hook-data-'));
  const path = join(output, 'REPORT.mdown');
  await runHook('snapshot', cwd, pluginData);
  await writeFile(path, '# Report\n');
  const detected = await runHook('detect', cwd, pluginData, { tool_name: 'Write', tool_input: { output_path: path } });
  assert.match(detected.stdout, /REPORT\.mdown/);
  assert.match((await runHook('stop', cwd, pluginData, { turn_id: 'one' })).stdout, /REPORT\.mdown/);
  await runHook('detect', cwd, pluginData, {
    tool_name: 'mcp__codex_apps__pretty_md_pretty_md_render',
    tool_input: { markdown: '# Report\n', filename: path },
    tool_response: { structuredContent: { viewUrl: 'https://example.test/view/id' } },
  });
  assert.equal((await runHook('stop', cwd, pluginData, { turn_id: 'two' })).stdout, '');
});

const planText = '# Reader delivery plan\n\n## Changes\n\n1. Track completed plans.\n2. Attach the reader link.\n\n## Verification\n\n- Test mobile delivery.';
const planMessage = `<proposed_plan>\n${planText}\n</proposed_plan>`;
const planUrl = 'https://pretty-md.yourshows12.chatgpt.site/view/0123456789abcdef0123456789abcdef';

async function planFixture() {
  return {
    cwd: await mkdtemp(join(tmpdir(), 'pretty-md-plan-project-')),
    data: await mkdtemp(join(tmpdir(), 'pretty-md-plan-data-')),
  };
}

async function renderPlan(fixture, markdown = planText, response = { structuredContent: { viewUrl: planUrl } }) {
  return runHook('detect', fixture.cwd, fixture.data, {
    tool_name: 'mcp__pretty_md__pretty_md_render',
    tool_input: { arguments: { markdown, filename: 'plan.md' } },
    tool_response: { result: response },
  });
}

test('Plan-mode discovery survives the shortened skill catalog without a project or Markdown request', async () => {
  const skill = await readFile(join(root, 'skills', 'plan-reader', 'SKILL.md'), 'utf8');
  const description = skill.match(/^description: (.+)$/m)?.[1];
  assert.ok(description);
  const visibleDescription = description.slice(0, 95);
  assert.match(visibleDescription, /Plan mode/i);
  assert.match(visibleDescription, /render/i);
  assert.match(skill, /without a project/i);
  assert.match(skill, /PDF/i);
});

test('Plan mode prompts activate delivery before any file exists', async () => {
  const { cwd, data } = await planFixture();
  const result = await runHook('prompt', cwd, data, { permission_mode: 'plan' });
  const context = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(context.hookEventName, 'UserPromptSubmit');
  assert.match(context.additionalContext, /pretty_md_render/);
  assert.match(context.additionalContext, /outside.*proposed_plan/s);
  assert.match(context.additionalContext, /Do not implement/);
});

test('Stop recovers a native plan without a saved file or SessionStart', async () => {
  const { cwd, data } = await planFixture();
  const result = await runHook('stop', cwd, data, { turn_id: 'plan-1', last_assistant_message: planMessage });
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /pretty_md_render/);
  assert.match(output.reason, /plan\.markdown/);
  assert.match(output.reason, /Do not implement/);
  assert.match(output.reason, /untrusted document data/);
});

test('plain Plan-mode plans are detected, but questions and quoted plan examples are not', async () => {
  for (const [message, permission_mode, expected] of [
    [planText, 'plan', true],
    ['Which database do you prefer?', 'plan', false],
    [planText, 'default', false],
    ['Example:\n```xml\n' + planMessage + '\n```', 'default', false],
    ['<proposed_plan>incomplete', 'plan', false],
  ]) {
    const { cwd, data } = await planFixture();
    const result = await runHook('stop', cwd, data, { permission_mode, last_assistant_message: message });
    assert.equal(Boolean(result.stdout), expected, message);
  }
});

test('successful rendering is not delivery: Stop reuses the exact receipt until the link is in chat', async () => {
  const fixture = await planFixture();
  await renderPlan(fixture);
  const missing = await runHook('stop', fixture.cwd, fixture.data, { turn_id: 'plan-1', last_assistant_message: planMessage });
  assert.match(JSON.parse(missing.stdout).reason, /Reuse/);
  assert.match(JSON.parse(missing.stdout).reason, new RegExp(planUrl));
  const delivered = await runHook('stop', fixture.cwd, fixture.data, {
    turn_id: 'continued', stop_hook_active: true,
    last_assistant_message: `[Open in Pretty MD](${planUrl})\n\nReader link expires in 24 hours.`,
  });
  assert.equal(delivered.stdout, '');
  const repeat = await runHook('stop', fixture.cwd, fixture.data, { turn_id: 'later', last_assistant_message: planMessage });
  assert.match(JSON.parse(repeat.stdout).reason, /Reuse/, 'a newly shown unchanged plan still needs its link, but not another render');
});

test('a guessed link, failed render, and mismatched source cannot satisfy plan delivery', async () => {
  for (const kind of ['guessed', 'failed', 'different', 'unsafe']) {
    const fixture = await planFixture();
    if (kind === 'failed') await renderPlan(fixture, planText, { isError: true, structuredContent: { viewUrl: planUrl } });
    if (kind === 'different') await renderPlan(fixture, '# Another plan');
    if (kind === 'unsafe') await renderPlan(fixture, planText, { structuredContent: { viewUrl: 'javascript:alert(1)' } });
    const result = await runHook('stop', fixture.cwd, fixture.data, {
      last_assistant_message: `${planMessage}\n\n[Open in Pretty MD](${planUrl})`,
    });
    assert.equal(JSON.parse(result.stdout).decision, 'block', kind);
    assert.doesNotMatch(JSON.parse(result.stdout).reason, /Reuse/, kind);
  }
});

test('exact rendered plans with a footer pass, while revisions require a fresh render', async () => {
  const fixture = await planFixture();
  await renderPlan(fixture);
  const delivered = await runHook('stop', fixture.cwd, fixture.data, {
    last_assistant_message: `${planMessage}\n\n[Open in Pretty MD](${planUrl})\n\nReader link expires in 24 hours.`,
  });
  assert.equal(delivered.stdout, '');
  const revised = await runHook('stop', fixture.cwd, fixture.data, {
    last_assistant_message: planMessage.replace('Track completed plans.', 'Track revised plans.'),
  });
  assert.equal(JSON.parse(revised.stdout).decision, 'block');
  assert.doesNotMatch(JSON.parse(revised.stdout).reason, /Reuse/);
});

test('plan recovery retries boundedly even during Stop continuation, then reports failure visibly', async () => {
  const { cwd, data } = await planFixture();
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await runHook('stop', cwd, data, {
      turn_id: `continuation-${attempt}`, stop_hook_active: attempt > 0,
      last_assistant_message: attempt === 0 ? planMessage : 'The reader is not ready yet.',
    });
    assert.equal(JSON.parse(result.stdout).decision, 'block');
  }
  const exhausted = JSON.parse((await runHook('stop', cwd, data, {
    stop_hook_active: true, last_assistant_message: 'Still unavailable.',
  })).stdout);
  assert.equal(exhausted.decision, undefined);
  assert.match(exhausted.systemMessage, /Pretty MD.*not.*delivered/i);
});

test('plan receipts expire, survive snapshot resume, and cannot cross chat sessions', async () => {
  const fixture = await planFixture();
  await renderPlan(fixture);
  await runHook('snapshot', fixture.cwd, fixture.data);
  const resumed = await runHook('stop', fixture.cwd, fixture.data, { last_assistant_message: planMessage });
  assert.match(JSON.parse(resumed.stdout).reason, /Reuse/);
  const otherChat = await runHook('stop', fixture.cwd, fixture.data, { session_id: 'another-chat', last_assistant_message: planMessage });
  assert.doesNotMatch(JSON.parse(otherChat.stdout).reason, /Reuse/);
  const state = {};
  rememberRender(state, { tool_name: 'pretty_md_render', tool_input: { markdown: planText }, tool_response: { structuredContent: { viewUrl: planUrl } } }, 1000);
  const expired = checkPlanDelivery(state, { last_assistant_message: `${planMessage}\n\n[Open in Pretty MD](${planUrl})` }, '/tmp/state.json', 1000 + 24 * 60 * 60 * 1000);
  assert.equal(expired.decision, 'block');
  assert.doesNotMatch(expired.reason, /Reuse/);
});

test('link examples in code, bare URLs, and images are not proof of delivery', () => {
  for (const footer of [planUrl, `\`\`\`md\n[Open in Pretty MD](${planUrl})\n\`\`\``, `![reader](${planUrl})`, `\`[Open in Pretty MD](${planUrl})\``]) {
    const state = {};
    rememberRender(state, { tool_name: 'pretty_md_render', tool_input: { markdown: planText }, tool_response: { structuredContent: { viewUrl: planUrl } } });
    assert.equal(checkPlanDelivery(state, { last_assistant_message: `${planMessage}\n\n${footer}` }, '/tmp/state.json')?.decision, 'block', footer);
  }
});

test('native plan contents retain code fences exactly, and plaintext footers do not change their fingerprint', () => {
  const markdown = '# Test\n\n```xml\n<proposed_plan>\nexample\n</proposed_plan>\n```\n\n1. Keep the example.';
  assert.equal(completedPlan(`<proposed_plan>\n${markdown}\n</proposed_plan>`, 'plan'), markdown);
  const state = {};
  rememberRender(state, { tool_name: 'pretty_md_render', tool_input: { markdown: planText }, tool_response: { structuredContent: { viewUrl: planUrl } } });
  assert.equal(checkPlanDelivery(state, { permission_mode: 'plan', last_assistant_message: `${planText}\n\n[Open in Pretty MD](${planUrl})\n\nReader link expires in 24 hours.` }, '/tmp/state.json'), null);
});

test('concurrent renders retain every receipt in a session', async () => {
  const fixture = await planFixture();
  await Promise.all(Array.from({ length: 12 }, (_, index) => renderPlan(fixture, `${planText}\n\nRevision ${index}`)));
  for (let index = 0; index < 12; index++) {
    const result = await runHook('stop', fixture.cwd, fixture.data, {
      last_assistant_message: `<proposed_plan>\n${planText}\n\nRevision ${index}\n</proposed_plan>`,
    });
    assert.match(JSON.parse(result.stdout).reason, /Reuse/);
  }
});

test('hosts requiring a plan-only final block can put the footer after the plan text inside the card', () => {
  const state = {};
  rememberRender(state, { tool_name: 'pretty_md_render', tool_input: { markdown: planText }, tool_response: { structuredContent: { viewUrl: planUrl } } });
  const result = checkPlanDelivery(state, {
    last_assistant_message: `<proposed_plan>\n${planText}\n\n[Open in Pretty MD](${planUrl})\n\nReader link expires in 24 hours.\n</proposed_plan>`,
  }, '/tmp/state.json');
  assert.equal(result, null);
  assert.equal(state.plan.markdown, undefined, 'successful delivery removes the locally retained plan text');
});

test('Plan-mode prose plans do not require bullet points', () => {
  const markdown = '# Reader-link plan\n\n## Approach\n\nRender the final plan before returning it.\n\n## Verification\n\nVerify that its reader link opens.';
  assert.equal(completedPlan(markdown, 'plan'), markdown);
  assert.equal(completedPlan(markdown, 'default'), null, 'ordinary explanations outside Plan mode are not auto-published');
});

test('Plan-mode clarification questions with headings are not completed plans', () => {
  assert.equal(completedPlan('# Questions\n\n## Hosting\n\nWhich host should I use?\n\n## Access\n\nWho needs access?', 'plan'), null);
});
