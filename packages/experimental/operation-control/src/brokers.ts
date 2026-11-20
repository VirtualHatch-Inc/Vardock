/** Route broker calls among the providers mounted for one authority. */
import { createHash } from 'node:crypto'
import {
  BrokerError, type BrokerActionDescription, type BrokerCorrelation, type BrokerObservation, type BrokerRequestIdentity,
  type BrokerResolution, type BrokerReviewPresentation, type OperationBroker, type PreparedBrokerRequest,
} from '@deepseek-ai/dsh-operation-broker'

/** The broker operations the authority uses. */
export type AuthorityBroker = Pick<OperationBroker, 'fingerprint' | 'actions' | 'resolve' | 'reviewPresentation' | 'run' | 'reconcile'>

/**
 * Present the mounted broker providers as one, selecting the provider that lists the requested action.
 * @param providers - Mounted providers in configuration order.
 * @returns A broker whose fingerprint covers every provider in that order.
 * @throws When two providers list the same action while the authority starts.
 */
export function combineBrokers(providers: readonly AuthorityBroker[]): AuthorityBroker {
  const actions = (): BrokerActionDescription[] => providers.flatMap(provider => provider.actions())
    .sort((left, right) => left.action.localeCompare(right.action, 'en'))
  const duplicate = actions().find((entry, index, all) => all[index + 1]?.action === entry.action)
  if (duplicate !== undefined) throw new Error(`Broker action "${duplicate.action}" is provided more than once.`)
  const providerOf = (action: string): AuthorityBroker => {
    const provider = providers.find(candidate => candidate.actions().some(entry => entry.action === action))
    if (provider === undefined) throw new BrokerError('broker-action-unavailable', 'not-sent', 'The broker action is not configured.')
    return provider
  }
  return {
    fingerprint: createHash('sha256').update(JSON.stringify(providers.map(provider => provider.fingerprint))).digest('hex'),
    actions,
    resolve: (action: string, body: string, identity: BrokerRequestIdentity): PreparedBrokerRequest =>
      providerOf(action).resolve(action, body, identity),
    reviewPresentation: (spec: PreparedBrokerRequest): BrokerReviewPresentation | undefined =>
      providerOf(spec.action).reviewPresentation(spec),
    run: async (spec: PreparedBrokerRequest, correlation: BrokerCorrelation, signal: AbortSignal): Promise<BrokerObservation> =>
      await providerOf(spec.action).run(spec, correlation, signal),
    reconcile: async (spec: PreparedBrokerRequest, correlation: BrokerCorrelation, signal: AbortSignal): Promise<BrokerResolution> =>
      await providerOf(spec.action).reconcile(spec, correlation, signal),
  }
}
