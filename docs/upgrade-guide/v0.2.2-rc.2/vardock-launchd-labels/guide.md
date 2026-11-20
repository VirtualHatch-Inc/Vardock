---
kind: upgrade-guide
description: "Vardock's launchd job labels changed from `io.deepseek.dsh.assistant-dev.<role>` to `io.github.virtualhatch-inc.vardock.<role>`, and new setups write the authority principal `owner`."
---

# Vardock launchd job labels

English | [中文](guide.zh.md)

## Change

`pnpm vardock setup` names the witness, authority, and Web launchd jobs `io.github.virtualhatch-inc.vardock.<role>` and writes them to `<home>/io.github.virtualhatch-inc.vardock.<role>.plist`. Earlier setups used `io.deepseek.dsh.assistant-dev.<role>`. New setups also write `principalId: "owner"` instead of `"assistant-dev"` in the `operation-control` row of the authority profile.

This affects a deployment prepared from the development repository before this change. Every `pnpm vardock` command now refuses to act while jobs with the earlier labels are loaded or while the selected home holds job files with the earlier labels, and prints the steps below.

## Migration

Replace `<home>` with the deployment directory, `$HOME/.vardock` or the `--home` you used.

1. Unload the jobs. Before updating the checkout, run `pnpm vardock stop --home <home>`. After updating it, run `launchctl bootout gui/$(id -u)/io.deepseek.dsh.assistant-dev.web`, then the same command for `.authority` and `.witness`; skip a job that `launchctl print` reports as not found.
2. Rename the job files and their labels:

   ```sh
   cd <home>
   for role in witness authority web; do
     mv "io.deepseek.dsh.assistant-dev.$role.plist" "io.github.virtualhatch-inc.vardock.$role.plist"
     plutil -replace Label -string "io.github.virtualhatch-inc.vardock.$role" "io.github.virtualhatch-inc.vardock.$role.plist"
   done
   ```

   `plutil` keeps the files' private permissions.
3. Leave `<home>/authority/profiles/operation-authority/cordis.patch.yml` unchanged. Its `principalId` keys the grant and its usage limits, the operation and work records, and the VM workspace names in the authority's data; changing it detaches them.
4. Run `pnpm vardock doctor --home <home>`, then `pnpm vardock start --home <home>`. Confirm that start prints `Vardock is ready.`, that **Assistant work** shows the earlier remaining reservations, and that `pnpm vardock verify --home <home>` prints `OK  Every compared event matches.`
