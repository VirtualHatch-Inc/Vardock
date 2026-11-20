---
kind: upgrade-guide
description: "The Assistant overlay removes inherited Host controls and settings that do not configure Vardock work."
---

# Assistant overlay removes unrelated Host controls

English | [中文](guide.zh.md)

## Change

The [Assistant overlay](../../../../packages/experimental/assistant/cordis.patch.yml) disables inherited settings, command sources, coding-workflow cards and Host terminal, browser, file and native-app controls. Model and account settings no longer appear; use Connections for Vardock credentials. Office conversion, Office skills, account notification polling and inherited session-log uploads are disabled. The PTC, minimal and Cordis presets, the MCP server manager, DeepSeek account service, Session telemetry export, Cordis provider inspection and the Host directory picker are unmounted, so the sidebar no longer offers to add a workspace. These changes affect Web profiles that load the Assistant overlay, including deployments created by `vardock setup`; ordinary DSH profiles are unchanged.

The [Assistant README](../../../../packages/experimental/assistant/README.md#use-this-package) groups the disabled controls and names what remains available. Assistant result file cards, inline previews and downloads remain available. Preset controls remain because the read-only inventory uses their dictionaries. The overlay sets `plugin-manager` to `management: fixed`: no bundle catalog or change controls are offered, and manager mutations are refused. Other profiles retain the default `full` mode.

An optional bundle enabled in an existing deployment stays active until its profile is edited; restricting the manager does not deactivate it. Remove the automatic authorization review bundle, `@deepseek-ai/dsh-experimental-auto-review`, from `dsh.profile.bundles` in `<home>/web/profiles/web/package.json` before restarting.

## Migration

1. Update the checkout or installed Assistant package that the Web launcher's `--patch` points to, then restart your Vardock deployment at a suitable time. Existing profiles need no rewrite.
2. Use Connections and Business records on Plugins, Automation tasks for schedules, and the Assistant work row for worker results and artifacts.
3. Confirm that inherited Host controls and the plugin catalog and change controls have disappeared, then preview and download a result file from Assistant work.
4. If a custom DSH profile intentionally needs a disabled row, use a later `--patch` with its exact id and `disabled: false`. Office previews also require `office-kit`, `ui-sidebar-documentpreview` and a file-opening entry such as `ui-sidebar-files`. Such Host functionality is outside Vardock's verified work paths.
