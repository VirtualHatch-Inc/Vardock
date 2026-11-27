/** Keyless practice walkthrough through dsh profiles and the authority socket harness. */
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { OperationControlClient, OperationId, OperationStatus } from '@deepseek-ai/dsh-operation-control/library'
import { workIdSchema } from '../../../packages/experimental/operation-control/src/protocol.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'
import { practicePermissions as permissions, startPracticeStack } from './stack.ts'

it.skipIf(process.platform === 'win32')('reviews an exact update, confirms its receipt, and admits only the read under an owner rule', async (test) => {
  function approve(approver: OperationControlClient, pending: OperationStatus) {
    if (pending.review === undefined) throw new Error('Expected an approval review')
    return approver.decide({ id: pending.id, revision: pending.review.revision, payloadDigest: pending.review.payloadDigest, decision: 'approve' })
  }

  const { setup, patchPath, home, permitActions, client, approver, evidence } = await startPracticeStack(test)
  expect(permitActions).toEqual(['list-items', 'set-quantity'])
  expect(setup).toContain(`--authority-patch '${join(home, 'authority.patch.yml')}'`)
  const generated = await readFile(patchPath, 'utf8')
  expect(load(generated)).toEqual([{ id: 'operation-broker', config: { routes: expect.arrayContaining([
    {
      action: 'list-items', description: expect.any(String) as string, endpoint: 'https://127.0.0.1:19443/items',
      credentialRef: 'PRACTICE_TOKEN', ca: join(home, 'server.pem'), returnResponse: true,
    },
    {
      action: 'set-quantity', description: expect.any(String) as string, endpoint: 'https://127.0.0.1:19443/quantity',
      reconciliationEndpoint: 'https://127.0.0.1:19443/status', credentialRef: 'PRACTICE_TOKEN', ca: join(home, 'server.pem'),
    },
  ]) as object[] } }])
  for (const name of ['server.pem', 'server-key.pem', 'authority.patch.yml']) {
    expect((await stat(join(home, name))).mode & 0o777).toBe(0o600)
  }

  const sessionId = SessionId('practice-worker')
  const workId = workIdSchema.parse('c'.repeat(64))
  const delegation = await client.propose({
    requestKey: workId, sessionId: SessionId('assistant-main'),
    handoff: { kind: 'delegation', targetSessionId: sessionId, content: 'Practice inventory.', delegation: { workId, previousWorkId: null, permissions } },
  })
  expect(await client.execute(delegation.id)).toMatchObject({ state: 'settled' })
  const body = '{"sku":"pencil","quantity":7}'
  const parent = await client.propose({ requestKey: randomUUID(), sessionId, command: JSON.stringify({ requestKey: randomUUID(), action: 'set-quantity', body }) })
  const waiting = client.waitReview(parent.id)
  const sending = client.execute(parent.id)
  const pending = await waiting
  if (pending === undefined) throw new Error('Expected an attended business request')
  expect(pending).toMatchObject({ state: 'pending-approval', review: { business: { action: 'set-quantity', endpoint: 'https://127.0.0.1:19443/quantity', body } } })
  expect((await client.businessOperations(sessionId)).operations).toMatchObject([{ id: pending.id, state: 'pending-approval' }])
  await approve(approver, pending)
  expect(await sending).toMatchObject({ state: 'settled', outcome: { kind: 'exited', observation: { exitCode: 0 } } })
  const settled = await client.status(pending.id)
  expect((await evidence.get(`${pending.id}-outcome`))?.receipt).toEqual(settled.receipt)
  const confirmed = await client.reconcile(sessionId, pending.id)
  expect(confirmed.businessCompletion).toMatchObject({ kind: 'succeeded', receiptId: expect.any(String) as string })
  expect(confirmed.businessCompletion.receipt).toBeDefined()
  if (confirmed.businessCompletion.receipt === undefined) throw new Error('Expected witnessed lookup evidence')
  expect((await evidence.get(confirmed.businessCompletion.receipt.id))?.receipt).toEqual(confirmed.businessCompletion.receipt)

  const connections = await approver.brokerConnections()
  await approver.setBrokerConnection({ action: 'list-items', unattended: [{}], revision: connections.revision })
  const read = await client.propose({ requestKey: randomUUID(), sessionId, command: JSON.stringify({ requestKey: randomUUID(), action: 'list-items', body: '{}' }) })
  const automatic = await client.execute(read.id)
  if (automatic.outcome?.kind !== 'exited') throw new Error('Expected the rule-admitted read to finish')
  const returned = JSON.parse(automatic.outcome.observation.stdout) as { id: OperationId; body: string }
  expect(JSON.parse(returned.body)).toMatchObject({ items: expect.arrayContaining([{ sku: 'pencil', quantity: 7 }]) as object[] })
  expect((await evidence.get(`${returned.id}-outcome`))?.receipt).toEqual((await client.status(returned.id)).receipt)
  const update = await client.propose({ requestKey: randomUUID(), sessionId, command: JSON.stringify({ requestKey: randomUUID(), action: 'set-quantity', body: '{"sku":"pencil","quantity":8}' }) })
  const nextReview = client.waitReview(update.id)
  const nextExecution = client.execute(update.id)
  const stillWaiting = await nextReview
  expect(stillWaiting).toMatchObject({ state: 'pending-approval', review: { business: { action: 'set-quantity' } } })
  if (stillWaiting?.review === undefined) throw new Error('Expected update approval after the read rule')
  await approver.decide({ id: stillWaiting.id, revision: stillWaiting.review.revision, payloadDigest: stillWaiting.review.payloadDigest, decision: 'deny' })
  await nextExecution
})
