/** Opt-in Web smoke with signed-in Codex, an Apple VM, and a test-owned HTTPS service. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { OperationControlClient } from '@deepseek-ai/dsh-operation-control/library'
import { EvidenceClient } from '@deepseek-ai/dsh-operation-evidence/library'
import { SessionId } from '@deepseek-ai/dsh-session'
import { execa } from 'execa'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { newEnglishPage, saveFailureShot } from './support.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const assistant = join(repo, 'packages/experimental/assistant')
const inputName = 'registration-request.json'
const input = '{"country":"Japan","purpose":"synthetic-test"}'
const refused = '{"country":"Canada","purpose":"synthetic-test"}'
const inputDigest = createHash('sha256').update(input).digest('hex')
const artifact = 'registration-attachment-copy.json'
const action = 'register'
const credentialRef = 'DSH_ASSISTANT_E2E_REGISTRATION_TOKEN'
const token = 'synthetic-assistant-broker-token'
const receiptId = 'synthetic-registration-42'
const stageTimeout = 180_000

const script = `set -eu
test "$(ls /sys/class/net)" = lo
node --input-type=module <<'NODE'
import { randomUUID } from 'node:crypto'
import { copyFile, readFile } from 'node:fs/promises'
const path = 'input/${inputDigest}/${inputName}'
const body = await readFile(path, 'utf8')
await copyFile(path, '${artifact}')
for (const requestBody of [${JSON.stringify(refused)}, body]) {
  const response = await fetch(process.env.DSH_BROKER_URL, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: 'Bearer ' + process.env.DSH_BROKER_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ requestKey: randomUUID(), action: '${action}', body: requestBody }),
  })
  const { id, code } = await response.json()
  console.log(JSON.stringify({ id, code }))
}
NODE`

const prompt = `This is a synthetic integration test. Use list_work_inputs for the attached ${inputName}, then delegate_work exactly once with that input and request_key "synthetic-registration". Give the worker this exact shell script and the reporting instructions below. The worker should call exec exactly once with the script, without editing it or adding Markdown fences to the tool argument. The two operations have separate human approvals. Do not retry any external operation or reconcile it automatically. After delegate_work returns, finish this turn with a short acknowledgment. The work report will arrive independently.

${script}

After the script, the worker must call report_work with status completed, artifacts ["${artifact}"], and a short result describing the copy and the dispatch observations. Completion refers to the file copy and the test procedure. A lost broker response leaves the registration unconfirmed. Do not retry any operation.`

type Submission = { operationId: string | undefined; payloadDigest: string | undefined; body: string; authorization: string | undefined }
type Role = 'witness' | 'authority' | 'web'

function reachable(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    const finish = (ready: boolean) => { socket.destroy(); resolve(ready) }
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
    socket.setTimeout(1_000, () => { finish(false) })
  })
}

it.skipIf(process.platform !== 'darwin' || process.env.DSH_ASSISTANT_REAL_E2E !== '1')(
  'delegates through Codex, rejects one VM broker request, and reconciles the other after restart',
  async (test) => {
    // Use /tmp because the generated Unix socket paths must fit macOS sockaddr_un.
    const root = await mkdtemp('/tmp/dsh-assistant-e2e-')
    test.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const setup = join(root, 'roles')
    const certificate = join(root, 'cert.pem')
    const key = join(root, 'key.pem')
    const screenshots = process.env.DSH_ASSISTANT_SCREENSHOT_DIR
    const submissions: Submission[] = []
    const lookups: string[] = []
    const children = new Map<Role, ReturnType<typeof start>>()
    const authoritySocket = join(setup, 'authority', 'operation.sock')
    const witnessSocket = join(setup, 'witness', 'evidence.sock')
    const approvalSocket = join(setup, 'authority', 'approval.sock')
    const gatewaySocket = join(setup, 'authority', 'gateway.sock')
    const vmPrefix = 'dsh-vm-' + createHash('sha256').update(gatewaySocket).digest('hex').slice(0, 12) + '-'

    function start(role: Role) {
      const home = join(setup, role)
      const profile = role === 'web' ? 'web' : 'operation-' + role
      const args = ['--profile', profile]
      if (role === 'web') args.push(
        '--patch', join(assistant, 'cordis.patch.yml'),
        '--patch', fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
        '--host', '127.0.0.1', '--port', '0', '--no-open',
      )
      const launch = resolveExampleLaunch({
        srcBin: join(repo, 'apps/cli/src/bin.ts'), mode: 'lib', configArgs: args,
        env: {
          NODE_OPTIONS: undefined, NODE_PATH: undefined, TSX_TSCONFIG_PATH: undefined,
          DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1',
          DSH_OPERATION_SOCKET: role === 'web' ? authoritySocket : undefined,
          DSH_APPROVAL_SOCKET: role === 'web' ? approvalSocket : undefined,
          NODE_EXTRA_CA_CERTS: role === 'authority' ? certificate : undefined,
          OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, DEEPSEEK_API_KEY: undefined,
        },
      })
      const child = execa(launch.command, launch.args, {
        cwd: home, reject: false, stdin: 'ignore', forceKillAfterDelay: 10_000, env: launch.env,
      })
      children.set(role, child)
      return child
    }

    async function stop(role: Role, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
      const child = children.get(role)
      if (child === undefined) return
      child.kill(signal)
      const result = await child
      children.delete(role)
      return result
    }

    async function waitForRole(role: Role, child: ReturnType<typeof start>, readiness: Promise<void>): Promise<void> {
      await Promise.race([
        readiness,
        child.then((result) => { throw new Error(`${role} exited before readiness\n${result.stderr}`) }),
      ])
    }

    async function startService(role: 'witness' | 'authority', socket: string): Promise<void> {
      await waitForRole(role, start(role), expect.poll(() => reachable(socket), { timeout: 30_000 }).toBe(true))
    }

    async function startWeb(): Promise<string> {
      const web = start('web')
      let output = ''
      web.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
      const getUrl = () => /dsh web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
      await waitForRole('web', web, expect.poll(getUrl, { timeout: 30_000 }).toBeDefined())
      const url = getUrl()
      if (url === undefined) throw new Error('Web did not publish its URL')
      return url
    }

    await execa(process.execPath, ['--input-type=module', '-e',
      "const { prepare } = await import(process.argv[1]); await prepare(process.argv[2], '0', { model: { provider: 'codex-local', model: 'default' } })",
      join(assistant, 'vardock/prepare.mjs'), setup,
    ], { timeout: 10_000 })
    test.onTestFinished(async () => {
      for (const role of ['web', 'authority', 'witness'] as const) await stop(role)
      const { stdout } = await execa('container', ['list', '--all', '--quiet'], { timeout: 10_000 })
      for (const name of stdout.split('\n').filter(name => name.startsWith(vmPrefix))) {
        await execa('container', ['delete', '--force', name], { timeout: 10_000 })
      }
    })
    await execa('/usr/bin/openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', certificate,
    ], { timeout: 10_000 })
    const service = createServer({ cert: await readFile(certificate), key: await readFile(key) }, (request, response) => {
      const url = new URL(request.url ?? '/', 'https://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/register') {
        let body = ''
        request.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
        request.once('end', () => {
          submissions.push({
            operationId: request.headers['idempotency-key']?.toString(),
            payloadDigest: request.headers['x-dsh-request-digest']?.toString(),
            authorization: request.headers.authorization,
            body,
          })
          // Commit the registration before losing the transport response.
          request.socket.destroy()
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/registration-status') {
        lookups.push(url.search)
        const operationId = url.searchParams.get('operationId')
        const payloadDigest = url.searchParams.get('payloadDigest')
        const matched = submissions.some(submission =>
          operationId === submission.operationId && payloadDigest === submission.payloadDigest
          && submission.authorization === request.headers.authorization && submission.body === input,
        )
        if (matched) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ operationId, payloadDigest, status: 'succeeded', receiptId }))
          return
        }
      }
      response.writeHead(404).end()
    })
    test.onTestFinished(async () => {
      if (!service.listening) return
      await new Promise<void>((resolve, reject) => {
        service.close((error) => { if (error) reject(error); else resolve() })
        service.closeAllConnections()
      })
    })
    await new Promise<void>((resolve, reject) => { service.once('error', reject).listen(0, '127.0.0.1', resolve) })
    const address = service.address()
    if (address === null || typeof address === 'string') throw new Error('HTTPS fixture has no loopback address')
    const origin = `https://127.0.0.1:${address.port}`
    const endpoint = origin + '/register'
    const reconciliationEndpoint = origin + '/registration-status'
    const profile = join(setup, 'authority/profiles/operation-authority/cordis.patch.yml')
    const patch = JSON.parse(await readFile(profile, 'utf8')) as [{
      insert: { id: string; config?: { routes?: object[]; assistant?: { permissions: { brokerActions: string[] } } } }[]
    }]
    const broker = patch[0].insert.find(row => row.id === 'operation-broker')?.config
    const authority = patch[0].insert.find(row => row.id === 'operation-control')?.config
    if (broker === undefined || authority?.assistant === undefined) throw new Error('The prepared authority has no broker')
    broker.routes = [{ action, endpoint, reconciliationEndpoint, credentialRef }]
    authority.assistant.permissions.brokerActions = [action]
    await writeFile(profile, JSON.stringify(patch, null, 2) + '\n')
    await writeFile(join(setup, 'authority/.credentials.yaml'), `version: 1\nrefs:\n  ${credentialRef}: ${token}\n`, { mode: 0o600 })

    await startService('witness', witnessSocket)
    await startService('authority', authoritySocket)
    const url = await startWeb()
    const browser = await chromium.launch()
    test.onTestFinished(async () => { await browser.close() })
    const page = await newEnglishPage(browser)
    test.onTestFinished(async ({ task }) => {
      if (task.result?.state === 'fail') await saveFailureShot(page, 'assistant-real')
    })
    async function capture(name: string) {
      if (screenshots === undefined) return
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: join(screenshots, `real-${name}.png`), animations: 'disabled' })
    }
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    async function openEntrance(url: string, firstVisit: boolean) {
      expect((await page.goto(url))?.status()).toBe(200)
      if (firstVisit) await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByRole('button', { name: 'Assistant', exact: true }).click()
      await composer.waitFor()
    }
    await openEntrance(url, true)
    const workStatus = page.locator('[data-assistant-work]')
    const budget = workStatus.locator('[data-assistant-budget]')
    await budget.waitFor()
    expect(await budget.innerText()).toBe('100 left · 0 of 100 reserved')
    await page.locator('input[type="file"]').setInputFiles({
      name: inputName, mimeType: 'application/json', buffer: Buffer.from(input),
    })
    await page.getByRole('group', { name: 'Pending attachments' }).getByTitle(inputName).waitFor()
    await composer.fill(prompt)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()

    const review = page.locator('[data-approval-key]')
    const allow = review.getByRole('button', { name: 'Allow once', exact: true })
    await allow.waitFor({ timeout: stageTimeout })
    expect((await review.locator('pre').innerText()).trim()).toBe(script)
    expect(submissions).toEqual([])
    await workStatus.locator('[data-assistant-approval]').waitFor()
    await capture('shell-review')
    await allow.click()
    const details = (body: string) => `POST ${endpoint}\nCredential: ${credentialRef}\nStatus lookup: GET ${reconciliationEndpoint}\n\n${body}`
    const businessReview = review.filter({ hasText: `Allow external operation ${action}?` })
    const deniedReview = businessReview.filter({ hasText: refused })
    await deniedReview.waitFor({ timeout: stageTimeout })
    expect(await deniedReview.locator('pre').innerText()).toBe(details(refused))
    await capture('refused-review')
    await deniedReview.getByRole('button', { name: 'Reject', exact: true }).click()

    const approvedReview = businessReview.filter({ hasText: input })
    await approvedReview.waitFor({ timeout: stageTimeout })
    expect(await approvedReview.locator('pre').innerText()).toBe(details(input))
    expect(submissions).toEqual([])
    await capture('business-review')
    await approvedReview.getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect.poll(() => submissions.length, { timeout: 30_000 }).toBe(1)
    expect(submissions[0]).toMatchObject({ authorization: `Bearer ${token}`, body: input })
    expect(submissions[0]?.operationId).toMatch(/^[a-f0-9-]{36}$/u)
    expect(submissions[0]?.payloadDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(lookups).toEqual([])

    const artifactLink = page.getByRole('link', { name: `${artifact} Download`, exact: true })
    await artifactLink.waitFor({ timeout: stageTimeout })
    // Restart both processes with the same homes and verify that browsing the
    // recovered Assistant does not redispatch the POST or trigger a lookup.
    const killed = await stop('authority', 'SIGKILL')
    expect(killed, killed?.stderr).toMatchObject({ timedOut: false, signal: 'SIGKILL' })
    await workStatus.getByRole('status').filter({ hasText: 'Authority status unavailable' }).waitFor()
    await capture('authority-unavailable')
    const stopped = await stop('web')
    expect(stopped, stopped?.stderr).toMatchObject({ timedOut: false, exitCode: 0 })
    await startService('authority', authoritySocket)
    await openEntrance(await startWeb(), false)
    await artifactLink.waitFor()
    const workId = await page.locator('[data-assistant-artifacts]').getAttribute('data-assistant-artifacts')
    if (workId === null) throw new Error('The artifact has no associated work ID')
    const worker = SessionId(`assistant-work-${workId}`)
    const client = new OperationControlClient({ socketPath: authoritySocket })
    const business = await client.businessOperations(worker)
    expect(business.operations).toHaveLength(2)
    expect(business.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'canceled' }),
      expect.objectContaining({
        id: submissions[0]?.operationId, state: 'unknown', outcome: { kind: 'unknown', code: 'broker-response-unavailable' },
        businessCompletion: { kind: 'unconfirmed' }, canReconcile: true,
      }),
    ]))
    expect(lookups).toEqual([])
    expect(submissions).toHaveLength(1)
    const denied = business.operations.find(operation => operation.state === 'canceled')
    const uncertain = business.operations.find(operation => operation.state === 'unknown')
    if (denied === undefined || uncertain === undefined) throw new Error('The authority did not preserve both dispatch outcomes')
    await workStatus.locator('[data-assistant-attention]').waitFor()
    await workStatus.getByRole('button', { name: 'Assistant work', exact: true }).click()
    const workRow = workStatus.locator(`[data-assistant-work-id="${workId}"]`)
    const deniedEffect = workRow.locator(`[data-assistant-operation-id="${denied.id}"]`)
    await deniedEffect.getByText('Request not sent', { exact: true }).waitFor()
    const effect = workRow.locator(`[data-assistant-operation-id="${uncertain.id}"]`)
    const lookup = effect.getByRole('button', { name: 'Check outcome', exact: true })
    await lookup.waitFor()
    expect(await effect.getAttribute('data-business-status')).toBe('unconfirmed')
    await effect.getByText('External outcome unconfirmed', { exact: true }).waitFor()
    await capture('outcome-unknown')
    expect(lookups).toEqual([])
    await lookup.click()
    await effect.getByText('External success confirmed', { exact: true }).waitFor()
    expect(await effect.getAttribute('data-business-status')).toBe('succeeded')
    expect(await effect.innerText()).toContain(receiptId)
    await workRow.getByText('Dispatch outcome unknown', { exact: true }).waitFor()
    await lookup.waitFor({ state: 'hidden' })
    await capture('outcome-confirmed')
    const reconciled = (await client.businessOperations(worker)).operations.find(operation => operation.id === uncertain.id)
    expect(reconciled).toMatchObject({
      state: 'unknown', canReconcile: false, businessCompletion: { kind: 'succeeded', receiptId },
    })
    if (reconciled?.businessCompletion.kind !== 'succeeded' || reconciled.businessCompletion.receipt === undefined) {
      throw new Error('The reconciliation has no witness receipt')
    }
    const { receipt } = reconciled.businessCompletion
    const witness = new EvidenceClient({ socketPath: witnessSocket })
    expect(await witness.get(receipt.id)).toMatchObject({
      receipt, event: { operationId: uncertain.id, kind: 'outcome', body: { fact: 'business-reconciliation', kind: 'succeeded', receiptId } },
    })
    const [download] = await Promise.all([page.waitForEvent('download'), artifactLink.click()])
    expect(download.suggestedFilename()).toBe(artifact)
    const downloaded = await download.path()
    if (downloaded === null) throw new Error('The browser did not save the worker artifact')
    expect(await readFile(downloaded)).toEqual(Buffer.from(input))
    await capture('artifact')
    if (screenshots !== undefined) await download.saveAs(join(screenshots, artifact))
    expect(lookups).toHaveLength(1)
    expect(submissions).toHaveLength(1)
    if (screenshots !== undefined) await writeFile(join(screenshots, 'real-observations.json'), JSON.stringify({
      refusedDispatched: false,
      postCount: submissions.length, readOnlyLookupCount: lookups.length,
      operationId: uncertain.id, dispatch: reconciled.state, completion: reconciled.businessCompletion,
      attachmentSha256: inputDigest,
    }, null, 2) + '\n')
  },
  540_000,
)
