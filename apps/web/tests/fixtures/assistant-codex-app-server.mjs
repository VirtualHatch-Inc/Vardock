/** Serve the recorded Assistant responses over Codex app-server stdio. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [mainPath, workerPath, command, transport] = process.argv.slice(2)
const toolNamespace = 'dsh_harness'
assert.equal(command, 'app-server')
assert.equal(transport, '--stdio')
for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
  assert.equal(process.env[key], undefined, key)
}

const readEvents = path => readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
const replies = events => events.filter(event => event.type === 'assistant/message')
  .map(event => event.data.message.content[0])
const mainEvents = readEvents(mainPath)
const workerEvents = readEvents(workerPath)
const [listInputs, delegate, acknowledge, checkPending, pending, list, checkFinal, final] = replies(mainEvents)
const [exec, report] = replies(workerEvents)
const resultText = (events, call) => events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.id)
  .data.message.content.find(block => block.type === 'text').text
const [humanPrompt, followup] = mainEvents.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
  .map(event => event.data.content.find(block => block.type === 'text').text)
const workerPrompt = workerEvents.find(event => event.type === 'user/message' && event.data.source.kind === 'assistant-work').data.content[0].text
const workNotice = mainEvents.find(event => event.type === 'user/message' && event.data.source.kind === 'assistant-work').data.content[0].text

function selectReply(tools, history) {
  const users = history.filter(item => item.type === 'message' && item.role === 'user')
    .flatMap(item => item.content.map(part => part.text))
  if (tools.has('report_work')) {
    assert.deepEqual(tools, new Set(['exec', 'report_work']))
    assert(users.includes(workerPrompt))
    const result = history.find(item => item.type === 'function_call_output' && item.call_id === exec.id)
    if (result === undefined) return exec
    assert.deepEqual(history.find(item => item.type === 'function_call' && item.call_id === exec.id), responseItem(exec))
    assert.equal(result.output, resultText(workerEvents, exec))
    return report
  }
  assert.deepEqual(tools, new Set([
    'list_work_inputs', 'delegate_work', 'list_work', 'stop_work', 'list_business_actions', 'inspect_business_operations',
    'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit', 'write_notes',
  ]))
  assert(users.includes(humanPrompt))
  const inputs = history.find(item => item.type === 'function_call_output' && item.call_id === listInputs.id)
  if (inputs === undefined) return listInputs
  assert.deepEqual(history.find(item => item.type === 'function_call' && item.call_id === listInputs.id), responseItem(listInputs))
  assert.equal(inputs.output, resultText(mainEvents, listInputs))
  const result = history.find(item => item.type === 'function_call_output' && item.call_id === delegate.id)
  if (result === undefined) return delegate

  assert.deepEqual(history.find(item => item.type === 'function_call' && item.call_id === delegate.id), responseItem(delegate))
  const delegated = JSON.parse(result.output)
  const replacements = text => text.replaceAll('{{session:2}}', delegated.sessionId).replaceAll('{{cwd}}', delegated.cwd)
  assert.equal(result.output, replacements(resultText(mainEvents, delegate)))
  const delivered = users.find(text => text.startsWith('{"work_id":'))
  if (delivered === undefined) return acknowledge
  if (JSON.parse(delivered).status === 'canceled') return { type: 'text', text: 'The work was stopped.' }

  assert.equal(delivered, replacements(workNotice))
  if (followup === undefined) return checkPending
  const later = users.includes(followup)
  if (later) {
    const work = history.find(item => item.type === 'function_call_output' && item.call_id === list.id)
    if (work === undefined) return list
    assert.deepEqual(history.find(item => item.type === 'function_call' && item.call_id === list.id), responseItem(list))
    assert.equal(work.output, replacements(resultText(mainEvents, list)))
  }
  const check = later ? checkFinal : checkPending
  const lookup = { ...check, arguments: check.arguments.replaceAll('{{session:2}}', delegated.sessionId) }
  const status = history.find(item => item.type === 'function_call_output' && item.call_id === lookup.id)
  if (status === undefined) return lookup
  assert.deepEqual(history.find(item => item.type === 'function_call' && item.call_id === lookup.id), responseItem(lookup))
  assert.equal(status.output, resultText(mainEvents, check).replaceAll('{{session:2}}', delegated.sessionId))
  return later ? final : pending
}

function responseItem(block) {
  if (block.type === 'tool-call') {
    return { type: 'function_call', namespace: toolNamespace, name: block.name, arguments: block.arguments, call_id: block.id }
  }
  assert.equal(block.type, 'text')
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text }] }
}

const threadId = 'fixture-thread'
const turnId = 'fixture-turn'
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n')
let tools
let history
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  const reply = result => send({ id, result })
  switch (method) {
    case 'initialize':
      reply({})
      break
    case 'initialized':
      break
    case 'config/read':
      reply({ config: {} })
      break
    case 'thread/start': {
      assert.equal(params.ephemeral, true)
      assert.equal(params.model, undefined)
      assert.equal(params.dynamicTools.length, 1)
      const [namespace] = params.dynamicTools
      assert.equal(namespace.type, 'namespace')
      assert.equal(namespace.name, toolNamespace)
      assert(namespace.tools.every(tool => tool.type === 'function'))
      tools = new Set(namespace.tools.map(tool => tool.name))
      reply({ thread: { id: threadId, ephemeral: true }, model: 'fixture-model' })
      break
    }
    case 'thread/inject_items':
      assert.equal(params.threadId, threadId)
      history = params.items
      reply({})
      break
    case 'turn/start': {
      assert.deepEqual(params, { threadId, input: [] })
      const item = responseItem(selectReply(tools, history))
      reply({ turn: { id: turnId } })
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } })
      send({ method: 'rawResponseItem/completed', params: { threadId, turnId, item } })
      send({ method: 'rawResponse/completed', params: { threadId, turnId, usage: null } })
      break
    }
    default:
      throw new Error(`Unexpected Codex app-server method ${method}`)
  }
}
