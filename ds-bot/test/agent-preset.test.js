import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Fei2411/DeepSeek-Bot#37: under DSH Desktop's default PTC preset a model may call only
// run_code, so the group_relay call made for a group chat's Session was turned down
// and no group message reached its Bots.
// Fei2411/DeepSeek-Bot#177: group chats and bots should share and inherit presets.

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  revision: 1,
  whaleStored: true,
  bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 } },
  rooms: { room: { id: 'room', name: 'Desk', members: ['chief'], admin: 'chief', mode: 'everyone', sessions: {}, seq: 0, log: [] } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start({ presets, composedPresets } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-agent-preset-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const composedMap = new Map(Object.entries(composedPresets ?? {}))
  const services = presets === undefined ? {} : {
    agentPresets: {
      list: async () => presets,
      composedPreset: ctx => (ctx?.sessionId ? composedMap.get(ctx.sessionId) : undefined),
    },
  }
  const ctx = fakeContext({ services })
  const created = []
  Object.assign(ctx, {
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id } : undefined),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async (request) => {
        created.push(request)
        return { sessionId: `new${created.length}` }
      },
      resolveAgent: async id => ({ agent: { id, session: { id }, ctx: { sessionId: id } } }),
    },
    sessionTitle: { rename: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  const relay = ctx.listeners.get('llm/stream').find(listener => /relayOrPass/.test(String(listener)))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, created, composedMap, relay, stop }
}

async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const userText = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const declared = (...names) => names.map(name => ({ name, description: '', parameters: {} }))
const relayCall = async (relay, tools) => {
  const chunks = await drain(relay({ provider: 'deepseek', model: 'v4', sessionId: 'room', messages: [userText('Hello team')], tools }, () => {
    throw new Error('a group round never reaches the model')
  }))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  return chunks.find(chunk => chunk.type === 'block-end').block
}

test('a new Bot Session is made with the standard preset when DSH serves it', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'ptc' }, { id: 'standard' }] })
  t.after(stop)
  await rt.load()
  await rt.createSession('Chief')
  assert.deepEqual(created, [{ workspaceId: 'w1', agentPreset: 'standard' }])
})

test('without a usable standard preset a Bot Session keeps DSH\'s default', async (t) => {
  for (const presets of [undefined, [{ id: 'ptc' }], [{ id: 'standard', broken: 'failed to start' }]]) {
    const { rt, created, stop } = start({ presets })
    t.after(stop)
    await rt.load()
    await rt.createSession('Chief')
    assert.deepEqual(created, [{ workspaceId: 'w1' }])
  }
})

test('a group round calls group_relay directly when the Session declares it', async (t) => {
  const { relay, stop } = start()
  t.after(stop)
  for (const tools of [declared('read', 'group_relay'), declared('run_code', 'group_relay')]) {
    const block = await relayCall(relay, tools)
    assert.deepEqual([block.name, block.arguments], ['group_relay', '{}'])
  }
})

test('a group made under the PTC preset relays through run_code', async (t) => {
  const { relay, stop } = start()
  t.after(stop)
  const block = await relayCall(relay, declared('run_code'))
  assert.equal(block.name, 'run_code')
  assert.deepEqual(JSON.parse(block.arguments), {
    description: 'Relay the group chat to its Bots',
    code: 'return await tools.group_relay({})',
    timeoutMs: 600_000,
  })
})

test('a Session is created with an explicit preset when specified', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'cordis' }, { id: 'standard' }] })
  t.after(stop)
  await rt.load()
  await rt.createSession('Special', { preset: 'cordis' })
  assert.deepEqual(created, [{ workspaceId: 'w1', agentPreset: 'cordis' }])
})

test('a group room session keeps standard relay environment while member session inherits group preset', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'cordis' }, { id: 'standard' }] })
  t.after(stop)
  await rt.load()
  const worker = await rt.createBot({ name: 'Worker', role: 'Dev', instructions: '' })
  const room = await rt.createRoom({ members: ['chief', worker.id], name: 'Meta', preset: 'cordis' })
  assert.equal(room.preset, 'cordis')
  // created[0] was worker session
  assert.deepEqual(created[0], { workspaceId: 'w1', agentPreset: 'standard' })
  // created[1] is room session (outer session keeps standard to safeguard group_relay)
  assert.deepEqual(created[1], { workspaceId: 'w1', agentPreset: 'standard' })
  await rt.groupSessionFor(room, rt.botOf('chief'))
  // created[2] is chief's group session, inheriting room.preset
  assert.deepEqual(created[2], { workspaceId: 'w1', agentPreset: 'cordis' })
})

test('group member session falls back to member preset when room preset is unset', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'cordis' }, { id: 'standard' }] })
  t.after(stop)
  await rt.load()
  const worker = await rt.createBot({ name: 'Worker', role: 'Dev', instructions: '', preset: 'cordis' })
  assert.equal(worker.preset, 'cordis')
  assert.deepEqual(created[0], { workspaceId: 'w1', agentPreset: 'cordis' })
  const room = await rt.createRoom({ members: ['chief', worker.id], name: 'PlainGroup' })
  assert.equal(room.preset, undefined)
  await rt.groupSessionFor(room, worker)
  // created[2] is worker's group session, inheriting worker.preset
  assert.deepEqual(created[2], { workspaceId: 'w1', agentPreset: 'cordis' })
})

test('group member dynamically inherits preset switched in classical DSH UI (Issue #177)', async (t) => {
  const { rt, created, composedMap, stop } = start({ presets: [{ id: 'cordis' }, { id: 'standard' }] })
  t.after(stop)
  await rt.load()
  const worker = await rt.createBot({ name: 'Worker', role: 'Dev', instructions: '' })
  const room = await rt.createRoom({ members: ['chief', worker.id], name: 'DynamicGroup' })
  assert.equal(room.preset, undefined)
  // Simulate user switching preset in classical DSH Web UI before starting chat
  composedMap.set(room.id, 'cordis')
  await rt.groupSessionFor(room, rt.botOf('chief'))
  // Chief's session in the room dynamically adopts the room agent's active preset
  assert.deepEqual(created[2], { workspaceId: 'w1', agentPreset: 'cordis' })
})

test('preset validation rejects unavailable or broken presets', async (t) => {
  const { rt, stop } = start({ presets: [{ id: 'standard' }, { id: 'broken-one', broken: 'syntax error' }] })
  t.after(stop)
  await rt.load()
  await assert.rejects(
    () => rt.createBot({ name: 'Invalid', role: 'Dev', instructions: '', preset: 'nonexistent' }),
    /Preset "nonexistent" is not available/
  )
  await assert.rejects(
    () => rt.createBot({ name: 'Invalid2', role: 'Dev', instructions: '', preset: 'broken-one' }),
    /Preset "broken-one" is not available/
  )
})

test('whitespace preset is cleaned and does not override member preset', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'cordis' }, { id: 'standard' }] })
  t.after(stop)
  await rt.load()
  const worker = await rt.createBot({ name: 'Worker', role: 'Dev', instructions: '', preset: 'cordis' })
  const room = await rt.createRoom({ members: ['chief', worker.id], name: 'WhitespaceGroup', preset: '   ' })
  assert.equal(room.preset, undefined)
  await rt.groupSessionFor(room, worker)
  assert.deepEqual(created[2], { workspaceId: 'w1', agentPreset: 'cordis' })
})

test('copyOf inherits source bot preset', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'cordis' }, { id: 'standard' }] })
  t.after(stop)
  await rt.load()
  const original = await rt.createBot({ name: 'Original', role: 'Dev', instructions: '', preset: 'cordis' })
  assert.equal(original.preset, 'cordis')
  const copy = await rt.createBot({ name: 'Clone', role: 'Dev', instructions: '', copyOf: original.id })
  assert.equal(copy.preset, 'cordis')
  assert.deepEqual(created[1], { workspaceId: 'w1', agentPreset: 'cordis' })
})
