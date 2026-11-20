/** The authority routes broker calls to the provider that lists the action. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerActionId, BrokerCorrelation, OperationBroker, PreparedBrokerRequest } from '@deepseek-ai/dsh-operation-broker'
import { expect, it, vi } from 'vitest'
import { combineBrokers, type AuthorityBroker } from '../src/brokers.ts'

const credentialRef = brandString<PreparedBrokerRequest['credentialRef']>('FIXTURE_TOKEN')
const brokerActionId = (value: string): BrokerActionId => brandString<BrokerActionId>(value)
const identity = { parentId: brandString<BrokerCorrelation['operationId']>('3a4f5a87-efc6-4dd7-b4fd-acb2ca11e22b'), requestKey: 'key' }
const correlation: BrokerCorrelation = { operationId: identity.parentId, payloadDigest: 'a'.repeat(64) }
const signal = new AbortController().signal

function provider(fingerprint: string, ...names: string[]) {
  const spec = (action: string, body: string): PreparedBrokerRequest => ({
    action: brokerActionId(action), method: 'POST', endpoint: `https://${fingerprint}.example/${action}`, credentialRef, body,
  })
  return {
    fingerprint,
    actions: vi.fn<OperationBroker['actions']>(() => names.map(name => ({ action: brokerActionId(name), credentialRef, routeDigest: 'a'.repeat(64) }))),
    resolve: vi.fn<OperationBroker['resolve']>((action, body) => spec(action, body)),
    reviewPresentation: vi.fn<OperationBroker['reviewPresentation']>(() => ({ title: { en: fingerprint }, detail: fingerprint })),
    run: vi.fn<OperationBroker['run']>().mockResolvedValue({ kind: 'http-response', statusCode: 200 }),
    reconcile: vi.fn<OperationBroker['reconcile']>().mockResolvedValue({ kind: 'pending' }),
  } satisfies AuthorityBroker
}

it('lists every action in order and sends each call to the provider that lists its action', async () => {
  const first = provider('first', 'post', 'archive')
  const second = provider('second', 'file-issue')
  const broker = combineBrokers([first, second])
  expect(broker.actions().map(entry => entry.action)).toEqual(['archive', 'file-issue', 'post'])
  expect(broker.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
  expect(broker.fingerprint).not.toBe(combineBrokers([second, first]).fingerprint)
  const spec = broker.resolve('file-issue', '{}', identity)
  expect(spec.endpoint).toBe('https://second.example/file-issue')
  expect(broker.reviewPresentation(spec)).toEqual({ title: { en: 'second' }, detail: 'second' })
  await broker.run(spec, correlation, signal)
  await broker.reconcile(spec, correlation, signal)
  expect(second.run).toHaveBeenCalledExactlyOnceWith(spec, correlation, signal)
  expect(second.reconcile).toHaveBeenCalledExactlyOnceWith(spec, correlation, signal)
  expect(first.resolve).not.toHaveBeenCalled()
  expect(first.run).not.toHaveBeenCalled()
  expect(() => broker.resolve('unknown', '{}', identity)).toThrow(expect.objectContaining({ code: 'broker-action-unavailable', dispatch: 'not-sent' }))
})

it('refuses providers that list the same action', () => {
  expect(() => combineBrokers([provider('first', 'post'), provider('second', 'post')])).toThrow('provided more than once')
})
