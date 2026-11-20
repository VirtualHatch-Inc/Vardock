/**
 * Method-level access control contracts: actions, roles, bindings, policies, guards,
 * decision requests, and the access snapshot stream.
 * @module @deepseek-ai/dsh-api-remote-access/types
 */

import type {
  Principal,
  RemoteAccessResource,
  RemoteAccessResourceKind,
  RemoteAccessResourceOf,
} from '@deepseek-ai/dsh-typert-protocol'

export type {
  RemoteAccessResource,
  RemoteAccessResourceKind,
  RemoteAccessResourceOf,
  TypertResourceKind,
  TypertResourceMap,
} from '@deepseek-ai/dsh-typert-protocol'

/** Canonical `<namespace>/<method>` Remote endpoint; its segments never contain `:`. */
export type RemoteAccessEndpoint = `${string}/${string}`

/** A Remote endpoint, or `event:<name>` for one forwarded event. */
export type RemoteAccessAction = RemoteAccessEndpoint | `event:${string}`

/** A named action set over one resource kind; a plain value the business package owns. */
export interface RemoteAccessRole<K extends RemoteAccessResourceKind> {
  /** Name for diagnostics; decisions read only `resource` and `actions`. */
  readonly name: string
  /** The resource kind every binding of this role names. */
  readonly resource: K
  /** Actions the role allows on its binding's resource. */
  readonly actions: readonly RemoteAccessAction[]
}

/** Answer of `decide()` and of a condition. */
export type RemoteAccessDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }

/**
 * Refines one binding for one action on its resource. Called synchronously,
 * only for a binding whose resource matches and whose role lists the action.
 * @param request - the action, the binding's resource, and the named
 *   arguments of a concrete call, validated against their Typert-compiled
 *   types with lookup parameters as wire identities; `args` is absent for
 *   events, snapshots, and list filtering, where the condition answers for
 *   the action alone.
 * @returns allow, or deny with the reason a refused call reports.
 */
export type RemoteAccessCondition<K extends RemoteAccessResourceKind> = (request: {
  readonly action: RemoteAccessAction
  readonly resource: RemoteAccessResourceOf<K>
  readonly args?: Readonly<Record<string, unknown>>
}) => RemoteAccessDecision

/** One role on one resource of the role's kind; the resource type follows from the role. */
export type RemoteAccessBinding = {
  [K in RemoteAccessResourceKind]: {
    readonly role: RemoteAccessRole<K>
    readonly resource: RemoteAccessResourceOf<K>
    /** Without a condition, the binding allows every action its role lists. */
    readonly condition?: RemoteAccessCondition<K>
  }
}[RemoteAccessResourceKind]

/** One access question: may `principal` take `action` on `resources`. */
export interface RemoteAccessRequest<P extends Principal> {
  readonly principal: P
  readonly action: RemoteAccessAction
  /**
   * Every resource the action touches, the global resource alone when it
   * names none; allowed only when the action is allowed on every listed resource.
   */
  readonly resources: readonly RemoteAccessResource[]
  /**
   * Named arguments of a concrete call. JSON values have passed their Typert
   * codecs. Lookup and Context identities retain their wire values. Absent
   * for events, snapshots, and list filtering.
   */
  readonly args?: Readonly<Record<string, unknown>>
}

/**
 * Refuse a Remote endpoint call or result item synchronously for any principal.
 * Read the request and current policy state without mutating either.
 * @param request - caller, endpoint, resources, and validated arguments when checking a call.
 * @returns a public refusal reason, or `undefined` to leave the access decision to other checks.
 */
export type RemoteAccessGuard = (request: RemoteAccessRequest<Principal>) => string | undefined

/**
 * Business rules for one non-owner principal kind. Every member answers
 * synchronously from state the business package holds in memory.
 */
export interface RemoteAccessPolicy<P extends Principal> {
  /**
   * List the principal's bindings. Called once per policy check and once per
   * snapshot computation; never cached.
   * @param principal - non-owner caller of this policy's kind.
   * @returns every binding the principal holds now.
   */
  bindings(principal: P): readonly RemoteAccessBinding[]
  /**
   * Name the reason for a request no binding allows; called only after the
   * decision is already a deny, so it never changes the decision.
   * @param request - the refused request.
   * @returns the reason a refused call reports, or `undefined` for `no-allow`.
   */
  explain?(request: RemoteAccessRequest<P>): string | undefined
}

/** Details of a refused Remote call. */
export interface RemoteAccessDeniedDetails {
  /** Canonical `<namespace>/<method>` endpoint of the refused call. */
  readonly action: string
  /**
   * A guard, condition, or `explain()` reason, or `no-allow`, `policy-failed`,
   * or `guard-failed`. The Gateway reports `resource-invalid` before `decide()`.
   */
  readonly reason: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'remote-access/denied': RemoteAccessDeniedDetails
  }
}

/** One principal's policy grants on one resource. */
export interface RemoteAccessGrant {
  readonly resource: RemoteAccessResource
  /**
   * Endpoint actions granted by policy without call arguments, sorted;
   * plain strings because Typert generates no codec for template literal types.
   */
  readonly actions: readonly string[]
}

/**
 * One frame of `remoteAccess/follow`. A generation opens with one baseline;
 * an owner baseline is the only frame of its generation.
 */
export type RemoteAccessFrame =
  | { readonly type: 'baseline'; readonly owner: true }
  | { readonly type: 'baseline'; readonly owner: false; readonly grants: readonly RemoteAccessGrant[] }
  | { readonly type: 'upsert'; readonly grant: RemoteAccessGrant }
  | { readonly type: 'remove'; readonly resource: RemoteAccessResource }
