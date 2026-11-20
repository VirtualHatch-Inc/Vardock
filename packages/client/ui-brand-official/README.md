---
description: "Client branding and the default click-triggered pixel whale on the home page."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

## Summary

This package supplies the sidebar and blank-home brand artwork and a click-triggered pixel whale. The shipped Web and Desktop compositions load it by default. The background owns only temporary canvas resources and adds no model requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shipped Web and Desktop compositions already mount this plugin. Home feedback and brand artwork require no additional installation.

### Choosing the profile

With `DSH_CLIENT_BUILD_PROFILE` unset, the sidebar and conversation hero use the Vardock V mark from `src/client/assets/vardock-mark.svg`. The expanded sidebar displays the name from the supplied logo next to the mark. Both images have a transparent backdrop: the mark and the name use a white stroke and white lettering in the dark theme and a navy stroke and dark lettering in the light theme; the blue part stays the same. An `official` build uses the DeepSeek Harness sidebar artwork and the animated hero fish. Other values use the shell’s fish marks and local-build label. The home background is shared across build profiles.

The Web shell supplies its Vardock install metadata and tab icons. Regenerate the Web icons from the mark with `pnpm --filter @deepseek-ai/dsh-web-frontend run render:app-icons`. The install icons place the light-theme mark on a white tile; the tab icon is the mark as SVG, whose navy stroke turns white under a dark browser color scheme.

### Home feedback

The default home stays clear until a primary click on empty space plays one light-gray whale breach. Successive completed clicks alternate between dots and code lettering, starting with dots. Both use the same large animated silhouette. The animation lasts 5.7 seconds, then clears. Repeated clicks leave the current playback uninterrupted. The whale's frame layer classifies clicks: blank space inside its frame triggers playback, including margins beside the input card, while input fields, controls, the input card, portaled overlays, and a click that ends a text selection never do. The canvas takes neither focus nor pointer events; the frame receives the clicks. On narrow homes the whale keeps a larger scale and is cropped at the canvas edges, without adding horizontal scrolling. Reduced-motion preference disables it, and leaving the blank home releases its animation and observers.

The whale uses very faint neutral theme ink, appearing as a subtle background texture; code lettering has more contrast than the dots. Water splashes retain fine particles with stronger ink, especially on the left during landing. A packaged frame atlas supplies the motion; the browser loads it once through the plugin asset route on the first eligible click. Code fills use dense 7px lettering drawn only from authored code slogans, and the moving silhouette clips text as it enters or leaves the water. Decode or pixel-read failures stop the decoration, leave home usable, and log a reload action.

The artwork values are fixed and the row takes no configuration. This is built-in presentation, without a separately installed bundle or Plugins-page toggle.

### Replacing the brand

A deployment with its own identity replaces this package with a package occupying the sidebar brand slots and `conversation.hero.brand.mark`. It can provide its own background through `conversation.hero.frame`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The two sidebar occupants install as one declaration-aware registration set: nested `ctx.slots.inject()` calls wait on the sidebar declaration, so the set works whether this row activates before or after the declarer, withdraws both occupants when the declaration collapses, and leaves no partial brand mix during HMR. The Vardock hero mark waits for its own declaration. The independent `conversation.hero.frame` layer owns the canvas renderer and waits for its declaration through `ctx.slots.inject()`. While `hero` is true it paints the canvas at negative `z-index`, which the frame contract places above the Conversation background and below all Conversation content. It plays on primary clicks that reach its own frame outside controls and the composer card; clicks from portaled overlays and clicks that end a text selection inside the frame are ignored. It never changes the composer or conversation state. The browser half is [`src/client/index.ts`](src/client/index.ts); the node half is an empty Loader seat. The [frame atlas](src/client/assets/breach-atlas.webp) derives from the user-supplied [showcase video](https://yinghuo-hg.deepseek.com/wuyexinrui/dev-cpu/web-showcase/orca.mp4): 1.5–7.2 seconds at 24 frames per second, sampled to 192 × 108 cells and stored as lossless WebP. Its red and green channels encode dot radius and opacity at 32 levels; the renderer reads it once after the first eligible click. The browser title is a build-environment concern (`DSH_CLIENT_TITLE`), outside the slot system.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the brand surface is not enough. They move from the slots this package occupies to the shell that renders them.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark` and `sidebar.brand.name` and renders their fallbacks.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero and the `conversation.hero.frame` layer this package occupies.
- [Web client architecture](../../../docs/subsystems/web-client.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how brand presentation is supplied. They are current package constraints, not a brand-design comparison or a task backlog.

- **One occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
- **Decorative rendering requires Canvas 2D** — unavailable contexts or reduced-motion preference leave the home clear.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
