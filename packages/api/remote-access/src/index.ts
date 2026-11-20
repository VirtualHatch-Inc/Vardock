/**
 * Host method-level access control. The Gateway asks `decide()` before it
 * dispatches a call or forwards an event to a non-owner Peer. List
 * methods filter items through `allows()`; every Peer reads its own access
 * snapshot, first from the index and then from `follow()`. Business packages
 * register endpoint guards and one policy per non-owner principal kind.
 * @module @deepseek-ai/dsh-api-remote-access
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  Remote,
  TypertRemoteService,
  principalOf,
  type Principal,
  type PrincipalMap,
  type RemoteAccessResource,
} from '@deepseek-ai/dsh-typert-protocol'
import { REMOTE_ACCESS_SNAPSHOT_KEY } from './snapshot.ts'
import type {
  RemoteAccessAction,
  RemoteAccessDecision,
  RemoteAccessFrame,
  RemoteAccessGrant,
  RemoteAccessGuard,
  RemoteAccessPolicy,
  RemoteAccessRequest,
} from './types.ts'

export type * from './types.ts'
export { REMOTE_ACCESS_SNAPSHOT_KEY } from './snapshot.ts'

/** The opening frame of a snapshot generation. */
export type RemoteAccessBaseline = Extract<RemoteAccessFrame, { type: 'baseline' }>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host method-level access control. */
    remoteAccess: RemoteAccessService
  }
}

/** The snapshot endpoint every Peer may read for itself. */
const FOLLOW_ACTION: RemoteAccessAction = 'remoteAccess/follow'
const ALLOW: RemoteAccessDecision = Object.freeze({ kind: 'allow' })
const NO_ALLOW: RemoteAccessDecision = Object.freeze({ kind: 'deny', reason: 'no-allow' })
const POLICY_FAILED: RemoteAccessDecision = Object.freeze({ kind: 'deny', reason: 'policy-failed' })
const OWNER: Principal = Object.freeze({ kind: 'owner' })
const OWNER_BASELINE: RemoteAccessBaseline = Object.freeze({ type: 'baseline', owner: true })

/**
 * A binding seen without its resource kind. Method syntax keeps the condition
 * of every kind assignable; each condition is called only with a resource
 * equal to its own binding's resource.
 */
interface ErasedBinding {
  readonly role: { readonly actions: readonly RemoteAccessAction[] }
  readonly resource: RemoteAccessResource
  condition?(request: {
    readonly action: RemoteAccessAction
    readonly resource: RemoteAccessResource
    readonly args?: Readonly<Record<string, unknown>>
  }): RemoteAccessDecision
}

/** One registered policy with the principal kind it serves. */
interface PolicyEntry {
  readonly kind: string
  readonly policy: RemoteAccessPolicy<Principal>
}

/** A refused access decision. */
type Refusal = Extract<RemoteAccessDecision, { kind: 'deny' }>

/** The answer for one action on one resource, before any `explain()`. */
type Evaluation =
  | { readonly kind: 'allow' }
  /** No binding allows; `refusal` is the first refusing condition's decision, if any condition ran. */
  | { readonly kind: 'refuse'; readonly refusal: Refusal | undefined }
  | { readonly kind: 'failed' }

const ALLOWED: Evaluation = Object.freeze({ kind: 'allow' })
const FAILED: Evaluation = Object.freeze({ kind: 'failed' })

/** One open non-owner snapshot generation; changes coalesce until its reader wakes. */
class AccessFollower {
  private dirty = false
  private wake: (() => void) | undefined

  /** @param principal - the generation's caller identity; never the owner. */
  constructor(readonly principal: Principal) {}

  /** Mark the generation stale and wake its reader. */
  touch(): void {
    this.dirty = true
    this.wake?.()
  }

  /**
   * Wait until the generation is stale or cancelled.
   * @param signal - generation cancellation.
   * @returns true when stale; false once cancelled.
   */
  async changed(signal: AbortSignal): Promise<boolean> {
    const abort = (): void => { this.wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!this.dirty && !signal.aborted) {
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
    this.dirty = false
    return !signal.aborted
  }
}

/**
 * Registry of access guards and policies, the Gateway's access decisions, list
 * filtering, and the per-Peer access snapshot. Every composition that mounts
 * the Gateway mounts this service too.
 */
export class RemoteAccessService extends TypertRemoteService {
  private readonly guards = new Set<RemoteAccessGuard>()
  private readonly policies = new Map<string, PolicyEntry>()
  /** Policies whose failure was logged since the last `invalidate()`; their later failures stay silent. */
  private readonly reported = new Set<PolicyEntry>()
  private readonly followers = new Set<AccessFollower>()
  /** Aborted when this instance unloads; every open snapshot generation ends with it. */
  private readonly lifetime = new AbortController()

  /** @param ctx - owning Host plugin Context. */
  constructor(ctx: Context) {
    super(ctx, 'remoteAccess')
    ctx.effect(() => () => { this.lifetime.abort() }, 'remoteAccess: snapshot generations')
    // Every index opens with the access snapshot of the Peer it speaks for.
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.on('webserver/index-inject', (table, peer) => {
        table.push({ kind: 'global', name: REMOTE_ACCESS_SNAPSHOT_KEY, value: this.snapshotFor(peer.principal) })
      })
    })
  }

  /**
   * Register the policy of one non-owner principal kind in the caller's
   * fiber; open snapshots are recomputed on registration and removal.
   * @param kind - the principal kind the policy serves; never `owner`.
   * @param policy - business-owned bindings and refusal reasons for principals of `kind`.
   * @returns disposer removing this policy.
   * @throws Error when `kind` already has a policy.
   */
  registerPolicy<K extends Exclude<keyof PrincipalMap, 'owner'>>(kind: K, policy: RemoteAccessPolicy<PrincipalMap[K]>): () => void {
    const policies = this.policies
    if (policies.has(kind)) throw new Error(`remote access: principal kind ${JSON.stringify(kind)} already has a policy`)
    const entry: PolicyEntry = { kind, policy }
    const dispose = this.ctx.effect(() => {
      policies.set(kind, entry)
      this.invalidate()
      return () => {
        policies.delete(kind)
        this.invalidate()
      }
    }, `remoteAccess.registerPolicy(${JSON.stringify(kind)})`)
    return () => { void dispose() }
  }

  /**
   * Register a synchronous endpoint guard in the caller's fiber. The first
   * refusal wins, including for the owner. A throwing guard refuses with
   * `guard-failed` and logs its first failure until removed.
   * @param guard - business-owned check for Remote calls and per-item filtering.
   * @returns disposer removing this registration.
   */
  guard(guard: RemoteAccessGuard): () => void {
    let reported = false
    const check: RemoteAccessGuard = (request) => {
      try {
        return guard(request)
      } catch (error) {
        if (!reported) {
          reported = true
          this.ctx.logger.warn(`remote access: guard failed for ${request.action}; the operation was refused`)
          this.ctx.logger.warn(error)
        }
        return 'guard-failed'
      }
    }
    const dispose = this.ctx.effect(() => {
      this.guards.add(check)
      return () => { this.guards.delete(check) }
    }, 'remoteAccess.guard')
    return () => { void dispose() }
  }

  /**
   * Report that the bindings or condition answers for `principal` may have
   * changed. Business packages call this on every grant, revocation, mode
   * change, and expiry; open snapshots re-push, and the next failure of each
   * policy is logged again.
   * @param principal - affected principal; omitted for every principal.
   */
  invalidate(principal?: Principal): void {
    this.reported.clear()
    const key = principal === undefined ? undefined : canonicalJson(principal)
    for (const follower of this.followers) {
      if (key === undefined || canonicalJson(follower.principal) === key) follower.touch()
    }
  }

  /**
   * Decide one request whose resources the Gateway resolved.
   * Endpoint guards run first. The owner and `remoteAccess/follow` then
   * qualify without policy bindings. Other requests require a matching role
   * that allows the action on every resource. Each policy check reads
   * `bindings()` once.
   * @param request - the caller or recipient, the action, the resources it
   *   touches, and a call's arguments.
   * @returns `allow` or a refusal. Guards supply their reason or `guard-failed`
   *   on exception. Policy refusals use the first refusing condition on the
   *   first resource without a grant, then `explain()`, then `no-allow`.
   *   Exceptions from policy callbacks produce `policy-failed`, logged once per
   *   policy until the next `invalidate()`. The Gateway throws
   *   `remote-access/denied` for a denied call and drops a denied event.
   */
  decide(request: RemoteAccessRequest<Principal>): RemoteAccessDecision {
    const { principal, action } = request
    if (!action.startsWith('event:')) {
      const refusal = this.guardRefusal(request)
      if (refusal !== undefined) return refusal
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    if (principal.kind === 'owner' || action === FOLLOW_ACTION) return ALLOW
    const entry = this.policies.get(principal.kind)
    if (entry === undefined) return NO_ALLOW
    const bindings = this.bindingsOf(entry, principal, action)
    if (bindings === undefined) return POLICY_FAILED
    for (const resource of request.resources) {
      const evaluation = this.evaluate(entry, bindings, action, resource, request.args)
      switch (evaluation.kind) {
        case 'allow':
          continue
        case 'failed':
          return POLICY_FAILED
        case 'refuse':
          return evaluation.refusal ?? this.explain(entry, request)
        /* v8 ignore next -- closed union. */
        default:
          return assertNever(evaluation)
      }
    }
    return ALLOW
  }

  /**
   * Filter items inside a Remote method. The invocation is read from the
   * Context that accessed this service, so call it as
   * `this.ctx.remoteAccess.allows(resource)` from the Remote method. Each
   * check reads the policy's bindings again, so a long-running stream sees
   * binding changes from the next check on.
   * @param resource - resource of one result item.
   * @returns true outside a Remote call. Inside one, true if no endpoint guard
   *   refuses and the owner or a policy binding permits the action on `resource`.
   *   Checks omit call arguments.
   */
  allows(resource: RemoteAccessResource): boolean {
    const invocation = this.ctx.invocation
    if (invocation === undefined) return true
    const principal = invocation.peer.principal
    const action: RemoteAccessAction = `${invocation.request.namespace}/${invocation.request.method}`
    if (this.guardRefusal({ principal, action, resources: [resource] }) !== undefined) return false
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    if (principal.kind === 'owner') return true
    const entry = this.policies.get(principal.kind)
    if (entry === undefined) return false
    const bindings = this.bindingsOf(entry, principal, action)
    return bindings !== undefined && this.evaluate(entry, bindings, action, resource, undefined).kind === 'allow'
  }

  /**
   * The baseline a page opens with before its snapshot stream connects; every
   * index the webServer renders carries it under
   * {@link REMOTE_ACCESS_SNAPSHOT_KEY} for the Peer the page speaks for.
   * @param principal - the page's caller identity.
   * @returns the owner baseline for the owner, or the principal's current policy grants.
   */
  snapshotFor(principal: Principal): RemoteAccessBaseline {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    if (principal.kind === 'owner') return OWNER_BASELINE
    return { type: 'baseline', owner: false, grants: this.grantsFor(principal) }
  }

  /**
   * Stream the calling Peer's access snapshot: one baseline, then `upsert`
   * and `remove` frames after each `invalidate()` and each policy
   * registration or removal that changes a grant. The owner receives only
   * `{ owner: true }`. The generation ends when `signal` aborts or this
   * service unloads, so a reloaded service starts every reader from a fresh
   * baseline.
   * @param signal - generation cancellation.
   * @returns the access frames of one generation.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<RemoteAccessFrame> {
    signal.throwIfAborted()
    const generation = AbortSignal.any([signal, this.lifetime.signal])
    const principal = principalOf(this.ctx.invocation)
    if (principal === undefined) {
      yield this.snapshotFor(OWNER)
      await abortion(generation)
      return
    }
    const follower = new AccessFollower(principal)
    this.followers.add(follower)
    try {
      let sent = this.grantsFor(principal)
      yield { type: 'baseline', owner: false, grants: sent }
      while (await follower.changed(generation)) {
        const next = this.grantsFor(principal)
        const previous = sent
        sent = next
        for (const grant of next) {
          const before = previous.find(other => sameResource(other.resource, grant.resource))
          if (before === undefined || !sameActions(before.actions, grant.actions)) yield { type: 'upsert', grant }
        }
        for (const grant of previous) {
          if (!next.some(other => sameResource(other.resource, grant.resource))) yield { type: 'remove', resource: grant.resource }
        }
      }
    } finally {
      this.followers.delete(follower)
    }
  }

  private guardRefusal(request: RemoteAccessRequest<Principal>): Refusal | undefined {
    for (const guard of this.guards) {
      const reason = guard(request)
      if (reason !== undefined) return { kind: 'deny', reason }
    }
    return undefined
  }

  /** One `bindings()` call; `undefined` after a logged failure. */
  private bindingsOf(entry: PolicyEntry, principal: Principal, purpose: string): readonly ErasedBinding[] | undefined {
    try {
      return entry.policy.bindings(principal)
    } catch (error) {
      // A policy failure is contained to this question, so one faulty rule cannot break a shared event stream.
      this.report(entry, `list bindings for ${purpose}`, error)
      return undefined
    }
  }

  /** Find a binding on `resource` whose role lists `action` and whose condition, if any, allows. */
  private evaluate(
    entry: PolicyEntry,
    bindings: readonly ErasedBinding[],
    action: RemoteAccessAction,
    resource: RemoteAccessResource,
    args: Readonly<Record<string, unknown>> | undefined,
  ): Evaluation {
    let refusal: Refusal | undefined
    for (const binding of bindings) {
      if (!sameResource(binding.resource, resource) || !binding.role.actions.includes(action)) continue
      if (binding.condition === undefined) return ALLOWED
      let decision: RemoteAccessDecision
      try {
        decision = binding.condition(args === undefined ? { action, resource } : { action, resource, args })
      } catch (error) {
        this.report(entry, `evaluate a condition for ${action}`, error)
        return FAILED
      }
      if (decision.kind === 'allow') return ALLOWED
      refusal ??= decision
    }
    return { kind: 'refuse', refusal }
  }

  /** The refusal reason `explain()` names, else `no-allow`; `policy-failed` when it throws. */
  private explain(entry: PolicyEntry, request: RemoteAccessRequest<Principal>): RemoteAccessDecision {
    let reason: string | undefined
    try {
      reason = entry.policy.explain?.(request)
    } catch (error) {
      this.report(entry, `explain a refusal of ${request.action}`, error)
      return POLICY_FAILED
    }
    return reason === undefined ? NO_ALLOW : { kind: 'deny', reason }
  }

  /**
   * One grant per bound resource, in first-binding order: the endpoint
   * actions allowed by its policy bindings without call arguments. A resource
   * with no such action gets no grant. Endpoint guards and event actions stay
   * out of the snapshot.
   */
  private grantsFor(principal: Principal): readonly RemoteAccessGrant[] {
    const entry = this.policies.get(principal.kind)
    if (entry === undefined) return []
    const bindings = this.bindingsOf(entry, principal, 'a snapshot')
    if (bindings === undefined) return []
    const grants: RemoteAccessGrant[] = []
    const seen: RemoteAccessResource[] = []
    for (const { resource } of bindings) {
      if (seen.some(other => sameResource(other, resource))) continue
      seen.push(resource)
      const candidates = new Set<RemoteAccessAction>()
      for (const binding of bindings) {
        if (!sameResource(binding.resource, resource)) continue
        for (const action of binding.role.actions) {
          if (!action.startsWith('event:')) candidates.add(action)
        }
      }
      const actions = [...candidates].filter(action => this.evaluate(entry, bindings, action, resource, undefined).kind === 'allow').sort()
      if (actions.length > 0) grants.push(Object.freeze({ resource, actions: Object.freeze(actions) }))
    }
    return grants
  }

  /** Log a policy failure once per policy until the next `invalidate()`; snapshots and lists ask many times per change. */
  private report(entry: PolicyEntry, action: string, error: unknown): void {
    if (this.reported.has(entry)) return
    this.reported.add(entry)
    this.ctx.logger.warn(
      `remote access: the ${JSON.stringify(entry.kind)} policy failed to ${action}; its further failures are not logged until access state changes`)
    this.ctx.logger.warn(error)
  }
}

/* v8 ignore next 3 -- closed-union backstop. */
function assertNever(value: never): never {
  throw new Error(`remote access: unreachable value ${JSON.stringify(value)}`)
}

/** Key-order-independent JSON text identifying one principal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    // Own keys are unique, so no two entries compare equal.
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Resources are equal when their kinds and ids are; `global` carries no id. */
function sameResource(
  left: { readonly kind: string; readonly id?: unknown },
  right: { readonly kind: string; readonly id?: unknown },
): boolean {
  return left.kind === right.kind && left.id === right.id
}

function sameActions(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((action, index) => action === right[index])
}

function abortion(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

export default RemoteAccessService
