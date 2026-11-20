---
kind: upgrade-guide
description: "Vardock setup accepts authority patches and broker destinations accept scoped CA files whose changes invalidate saved route rules."
---

# Configure authority connections at setup

English | [中文](guide.zh.md)

## Change

`pnpm vardock setup` accepts repeatable `--authority-patch <file>` options. The profile loader applies those files in order after the generated authority patch. Previously operators edited the generated profile to add connections and permissions. Setup preserves the other roles and refuses existing deployment directories.

HTTPS JSON broker routes and MCP server entries accept optional `ca` PEM file paths. Previously private-CA trust required process-wide configuration such as `NODE_EXTRA_CA_CERTS`. A configured CA replaces the default trust roots for only that route or endpoint; HTTPS status lookups use the same trust. Certificate and hostname verification stay enabled.

The CA path and content digest become part of the route digest and provider fingerprint recorded in the authority's witnessed configuration. Configurations without `ca` keep their existing identities. Changing a configured CA invalidates unconsumed permits and makes the owner's saved rules for that route inactive.

## Migration

1. Existing deployments need no change. For fresh setups, append `--authority-patch /absolute/path/service.yml` to the setup command with your model flags; repeat it for additional patches. Use complete row configurations: Cordis patches replace a row's entire `config`, rather than merging individual fields. See the [setup guide](../../../../packages/experimental/assistant/vardock/README.md#connect-a-service).
2. To trust a private CA, stop Vardock and set `ca: /absolute/path/company-ca.pem` on the intended broker route or MCP server in `<home>/authority/profiles/operation-authority/cordis.patch.yml`, or in a patch for a fresh setup. The file must contain valid PEM certificates and remain readable by the authority.
3. Start Vardock. It reads the CA at provider load and witnesses the changed configuration before admission. After a CA change, review and save rules for that action under Connections to restore unattended requests. Run `pnpm vardock verify` to compare the current configuration and operation receipts. Keep process-wide extra CAs only if other connections still need them.
