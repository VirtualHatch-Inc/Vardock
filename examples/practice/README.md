# Practice an approved inventory update

English | [中文](README.zh.md)

This tutorial uses a small local inventory to show approval, witnessed records, a confirmed outcome, and a rule that admits reads while updates still wait. No external service account is needed. You still need Vardock's macOS prerequisites and a model API key: follow the [setup guide](../../packages/experimental/assistant/vardock/README.md#prepare-the-checkout), and read [Safety](../../SAFETY.md). Model requests use your provider and may cost money.

## Prerequisites

From the checkout root, run `pnpm install` and confirm that installation finishes successfully. Port `19443` must be free. If another Vardock deployment is running, stop it using its own `--home` before stage 2; the launchd labels allow only one active deployment.

## Walkthrough: six stages

1. **Start the practice service.** In its own terminal, run:

   ```sh
   cd examples/practice
   DSH_HOME="$PWD" pnpm exec node --import tsx/esm ../../apps/cli/src/bin.ts --profile practice
   ```

   Expect `Practice inventory: https://127.0.0.1:19443` and one setup command. First start creates a self-signed IP certificate for `127.0.0.1` and its key under `$HOME/.vardock-practice`, with files mode `0600`. Keep this terminal running. Inventory starts with pencil 12, notebook 5, and eraser 8; restarting resets inventory and service outcome receipts.

   The generated `$HOME/.vardock-practice/authority.patch.yml` contains the two broker routes with the absolute certificate path, response return for the read, outcome lookup for the update, and no unattended rule.

2. **Prepare, start, and connect Vardock.** In a second terminal at the checkout root, copy the printed setup command. Replace `openai` and `<model-id>` with the provider route and model ID for your key:

   ```sh
   pnpm vardock setup --model-provider openai --model '<model-id>' --home "$HOME/.vardock-practice/deployment" --authority-patch "$HOME/.vardock-practice/authority.patch.yml" --permit-action list-items --permit-action set-quantity
   pnpm vardock start --home "$HOME/.vardock-practice/deployment"
   ```

   Expect `Prepared Vardock`, then the Vardock page to open. Setup builds the application and prepares a separate deployment under the practice home; it does not send a model request. The model, expiry, and other authority settings remain setup choices, and the default ceiling already permits `data.returnResponses`.

   On **Plugins → Connections**, save your model key in the model entry. Save `practice-only-token` in the `list-items` entry with **Save token**. This fixed value is deliberately made up, is public, and protects no real account. Both inventory actions share `PRACTICE_TOKEN`; **Read current connections** should show both configured. Both still say every request waits for approval.

3. **Request and approve an update.** Send this to the entrance:

   > In the connected practice inventory, set the pencil quantity to 7.

   Expect delegated work and a business approval card. Routine scripts run automatically in the isolated VM; external requests wait. If the worker first reads inventory, that read also waits because no read rule exists yet: inspect and approve it, then review the update.

   On the update's card, inspect the destination `https://127.0.0.1:19443/quantity` and the exact saved JSON body: `sku` should be `pencil` and `quantity` should be `7`. Select **Allow once** only if those values match. Expect the request to finish; approval covers this saved request.

4. **Inspect records, confirm the outcome, and verify.** Open **Plugins → Business records** and find `set-quantity` with the same destination and body, approval, HTTP result, and **Witness receipt recorded**. If the entrance has not already confirmed the outcome, select **Check outcome** in the work's operation details. Expect **A lookup confirmed it completed** after reading the record again. Confirm this update before stage 6 so an unresolved-action hold cannot explain why the next update waits.

   While Vardock runs, verify its compared evidence:

   ```sh
   pnpm vardock verify --home "$HOME/.vardock-practice/deployment"
   ```

   Expect `OK  Every compared event matches.` A successful HTTP response and a confirmed business outcome are separate facts; verification has the limits described in [Safety](../../SAFETY.md#threat-model).

5. **Enable only the read rule.** Return to **Connections**, find `list-items`, leave the rule's conditions and other-fields inputs empty, and select **Send without approval**. Expect **Approval rules saved** and **Every request is sent without approval** for this action. Leave `set-quantity` without a rule.

6. **Observe an automatic read and a waiting update.** Send this to the entrance:

   > Show me the inventory, then set the pencil quantity to 8.

   Expect a returned list containing pencil quantity 7 without a business approval card for the read. The update to 8 should still wait on its own approval card. In **Business records**, the read says **Sent without approval by a rule** and retains its witness receipt; the update says **Waiting for approval**. Decline the update to finish without another change.

## What just happened

Stages 1–2 fix the destinations and scope TLS trust to these routes; Connections keeps the token with the authority. Stage 3 demonstrates the saved-request approval and permission ceiling. Stage 4 distinguishes HTTP delivery, business completion, and witness evidence. Stages 5–6 show that an owner rule removes the decision for one action while preserving its records and leaving the other action attended. These are the [mediation and approval guarantees](../../SAFETY.md#approval-recovery-and-completion), subject to the [same-user threat model](../../SAFETY.md#threat-model).

The service accepts authenticated JSON POSTs at `/items` and `/quantity`; `/status` is a read-only GET matching the update's operation ID and payload digest. It retains each accepted update's digest and uses its operation ID as a stable service receipt until process exit. After a restart, a missing receipt cannot confirm an earlier outcome. Keep authority and witness records when investigating uncertainty; do not resend an uncertain update automatically. The certificate lasts 365 days; after stopping the deployment, remove the practice home to regenerate it, which also removes the deployment's records.

## Remove the example

Stop its deployment, then press Control-C in the service terminal:

```sh
pnpm vardock stop --home "$HOME/.vardock-practice/deployment"
```

To discard the example, remove `$HOME/.vardock-practice`. This permanently deletes its certificate and key, generated patch, deployment, saved credentials, and evidence. Shared VM/image cleanup is described in the [setup guide](../../packages/experimental/assistant/vardock/README.md#remove-a-deployment). Removing this deployment does not restore or start another deployment.

## Keyless verification

From the checkout root, with port `19443` free and no practice service already running:

```sh
pnpm run build:native-system
pnpm exec vitest run --config examples/practice/vitest.config.ts
```

Both tests start this profile, compose the patch with setup’s overlay loader and patch function, and run real authority and witness processes with a test execution provider. The first test checks the generated route settings, attended update approval, a witnessed outcome lookup, a rule-admitted read returning quantity 7, and an update still waiting, using the operation-control socket harness. The second runs the Assistant with a scripted model against the same processes and compares each work record with the inventory read directly from the service: an approved update stays `unknown` until its outcome lookup succeeds, a completion the worker only claims is recorded `completed` while the inventory is unchanged, and a declined update is recorded `failed` and never sent. The tests use private temporary homes, send no model requests, start no launchd jobs, run one at a time because the service uses a fixed port, and wait for their children to exit. A person must still run the six stages with a real model to verify model behavior and the cards in the browser.
