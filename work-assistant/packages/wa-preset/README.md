---
description: "Personal-assistant preset assets, scoped questions, and profile defaults for admitted calendar and memory tools."
kind: "package-bundle"
---

# Personal assistant preset

English | [中文](README.zh.md)

## Summary

Select a personal-assistant preset instead of the standard coding preset. The preset supplies stable scheduling, memory, and focused-question guidance, while the profile supplies admitted tools, the configured calendar source, and the configured memory repository. It does not mount shell, arbitrary filesystem, browser, code, workflow, subagent, todo, or generic skill-loader rows.

## Contents

- [Configuration](#configuration)
- [Preset asset](#preset-asset)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="configuration"></a>
## Configuration

Install this bundle only in the later isolated personal profile. Its patch changes the `agent-presets` row to `default: personal-assistant`, disables shipped presets with `includeShippedRoot: false`, and leaves the DSH home user preset root enabled.

The deployment step must copy this package's `presets\personal-assistant` directory to `$DSH_HOME\.agent-presets\personal-assistant` before launching the profile. Do not add a generic skill or filesystem loader to complete a five-bundle sketch; this preset owns its persona text, calendar access comes from `wa-calendar`, and memory access comes from `wa-memory`.

<a id="preset-asset"></a>
## Preset asset

The preset composition contains `@deepseek-ai/dsh-persona` and one scoped interaction row from this package. It tells the model to act as one user's personal assistant, use `calendar_list` and `calendar_find_conflicts` only for configured-calendar reads after explicit scheduling bounds are known, use `memory_read` before asking when notes can resolve context, and treat scheduling as draft-only.

The scoped interaction row loads the published `@deepseek-ai/dsh-tool-ask-user` package and admits only its exact `ask_user_question` definition through `wa-gateway`. The profile owns the user-question answerer and tool admission. A deployment normally layers `@deepseek-ai/dsh-wa-gateway`, `@deepseek-ai/dsh-wa-calendar`, `@deepseek-ai/dsh-wa-memory`, and this package over the DSH Web app profile, then patches `wa-calendar` and `wa-memory` with deployment-owned sources.

Cordis, scope, and tool services are Host-supplied peers. Installing private runtime copies can separate the preset's scope identity from its Agent and prevent composition.

<a id="model-experience"></a>
## Model Experience

### Personal assistant persona

#### Trigger

Every agent composed from the `personal-assistant` preset receives this package's persona prefix and suffix through the normal DSH system-prompt registry, and receives the scoped `ask_user_question` tool when `ctx.userQuestions` is available.

#### What the model sees

The model sees stable instructions to answer as a personal assistant, prepare with admitted read-only tools, request material choices through `ask_user_question`, treat scheduling as draft-only, and report only verified outcomes. It may occasionally reply with only a thumbs-up to acknowledge thanks or a low-stakes update that needs no answer or action; greetings, questions, substantive requests, distress, and confirmation decisions call for words or useful work instead. An emoji is not automatic and grants no approval. The model also sees that `ask_user_question` returns selected option labels plus optional custom text, not hidden approval ids.

#### Token effect

The persona contributes a fixed system-prompt section and the published ask-user tool schema for each request on this preset. No calendar data, memory note content, credential value, URL, file path, or mutable memory is embedded in the prompt by this package.

#### KV Cache effect

The persona text and ask-user schema are stable while the selected preset file and installed ask-user package are unchanged. Replacing the preset asset, changing the active preset, or changing the ask-user package invalidates that prefix.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The bundle does not copy preset assets into DSH home; deployment owns that file operation for the isolated profile.
- The preset supplies guidance and scoped user-question admission only. Gateway connector admission, calendar source policy, memory repository policy, and write approval behavior remain enforced by their owning packages.
- No runtime invariant companion is supplied: the runtime effect derives from DSH's tool registry and the gateway's exact-definition guard, with no independent state to compare.
