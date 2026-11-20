/** Process-local inventory and outcome receipts for the Vardock practice walkthrough. */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Start the loopback inventory; its certificate, key, and generated broker patch stay in the private home.
 * @param ctx - Profile lifecycle that owns the HTTPS listener and inventory.
 * @param config - Private practice home selected by the profile.
 * @returns Completion after listening and printing the setup command.
 */
export async function apply(ctx: Context, config: { home: string }): Promise<void> {
  const home = resolve(config.home)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const certificate = join(home, 'server.pem')
  const key = join(home, 'server-key.pem')
  const patch = join(home, 'authority.patch.yml')
  if (!existsSync(certificate)) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', certificate,
    ], { stdio: 'ignore' })
    for (const file of [certificate, key]) chmodSync(file, 0o600)
    writeFileSync(patch, `- id: operation-broker
  config:
    routes:
      - action: list-items
        description: 'List the practice inventory. The body is {}.'
        endpoint: https://127.0.0.1:19443/items
        credentialRef: PRACTICE_TOKEN
        ca: ${JSON.stringify(certificate)}
        returnResponse: true
      - action: set-quantity
        description: 'Set the quantity of an inventory item. Supply sku (pencil, notebook, or eraser) and quantity (a nonnegative integer). Example: {"sku":"pencil","quantity":7}.'
        endpoint: https://127.0.0.1:19443/quantity
        reconciliationEndpoint: https://127.0.0.1:19443/status
        credentialRef: PRACTICE_TOKEN
        ca: ${JSON.stringify(certificate)}
`, { mode: 0o600 })
  }
  await ctx.effect(async () => {
    const inventory = new Map([['pencil', 12], ['notebook', 5], ['eraser', 8]])
    const operations = new Map<string, string>()
    const server = createServer({ cert: readFileSync(certificate), key: readFileSync(key) }, (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.headers.authorization !== 'Bearer practice-only-token') {
        response.writeHead(401).end('{"error":"Save practice-only-token under Connections."}')
        return
      }
      const url = new URL(request.url ?? '/', 'https://127.0.0.1:19443')
      if (request.method === 'GET' && url.pathname === '/status') {
        const operationId = url.searchParams.get('operationId')
        const payloadDigest = url.searchParams.get('payloadDigest')
        const recordedDigest = operationId === null ? undefined : operations.get(operationId)
        if (recordedDigest === undefined || recordedDigest !== payloadDigest) response.writeHead(404).end('{}')
        else response.end(JSON.stringify({ operationId, payloadDigest, status: 'succeeded', receiptId: operationId }))
        return
      }
      if (request.method !== 'POST' || !['/items', '/quantity'].includes(url.pathname)) {
        response.writeHead(404).end('{}')
        return
      }
      let text = ''
      request.setEncoding('utf8').on('data', (chunk: string) => { text += chunk })
      request.once('end', () => {
        let value: unknown
        try { value = JSON.parse(text) } catch (_error) {
          // Invalid wire JSON has no inventory effect or business receipt.
          response.writeHead(400).end('{"error":"Send a JSON body."}')
          return
        }
        if (url.pathname === '/quantity') {
          if (typeof value !== 'object' || value === null || !('sku' in value) || !('quantity' in value)
            || typeof value.sku !== 'string' || !inventory.has(value.sku)
            || typeof value.quantity !== 'number' || !Number.isSafeInteger(value.quantity) || value.quantity < 0) {
            response.writeHead(400).end('{"error":"Use a seeded SKU and a nonnegative integer quantity."}')
            return
          }
          const operationId = request.headers['idempotency-key']
          const payloadDigest = request.headers['x-dsh-request-digest']
          if (typeof operationId !== 'string' || typeof payloadDigest !== 'string') {
            response.writeHead(400).end('{"error":"Broker correlation headers are required."}')
            return
          }
          inventory.set(value.sku, value.quantity)
          operations.set(operationId, payloadDigest)
        }
        const body = JSON.stringify({ items: [...inventory].map(([sku, quantity]) => ({ sku, quantity })) })
        response.end(body)
      })
    })
    await new Promise<void>((ready, reject) => { server.once('error', reject).listen(19443, '127.0.0.1', ready) })
    process.stdout.write(`Practice inventory: https://127.0.0.1:19443\npnpm vardock setup --model-provider openai --model '<model-id>' --home '${join(home, 'deployment').replaceAll("'", "'\\''")}' --authority-patch '${patch.replaceAll("'", "'\\''")}' --permit-action list-items --permit-action set-quantity\n`)
    return () => new Promise<void>((done, reject) => {
      server.close((error) => { if (error) reject(error); else done() })
      server.closeAllConnections()
    })
  })
}
