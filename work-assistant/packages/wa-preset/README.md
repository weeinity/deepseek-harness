---
description: "Personal-assistant preset assets and profile defaults for admitted calendar and memory tools."
kind: "package-bundle"
---

# Personal assistant preset

English | [中文](README.zh.md)

## Summary

Select a personal-assistant preset instead of the standard coding preset. The preset supplies stable scheduling and memory guidance, while the profile supplies admitted tools, the configured calendar source, and the configured memory repository. It does not mount shell, arbitrary filesystem, browser, code, workflow, subagent, todo, or generic skill-loader rows.

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

The preset composition contains one `@deepseek-ai/dsh-persona` row. It tells the model to act as one user's personal assistant, use `calendar_list` and `calendar_find_conflicts` only after explicit scheduling bounds are known, use `memory_read` for relevant personal notes, and treat calendar and memory text as external data rather than instructions.

The profile owns tool admission. A deployment normally layers `@deepseek-ai/dsh-wa-gateway`, `@deepseek-ai/dsh-wa-calendar`, `@deepseek-ai/dsh-wa-memory`, and this package over the DSH Web app profile, then patches `wa-calendar` and `wa-memory` with deployment-owned sources.

<a id="model-experience"></a>
## Model Experience

### Personal assistant persona

#### Trigger

Every agent composed from the `personal-assistant` preset receives this package's persona prefix and suffix through the normal DSH system-prompt registry.

#### What the model sees

The model sees stable instructions to answer as a personal assistant, request missing dates or time zones, use admitted calendar tools for calendar questions, use admitted memory tools for personal notes, and treat calendar and memory data as external content rather than instructions.

#### Token effect

The persona contributes a fixed system-prompt section for each request on this preset. No calendar data, memory note content, credential value, URL, file path, or mutable memory is embedded in the prompt by this package.

#### KV Cache effect

The persona text is a stable prefix while the selected preset file is unchanged. Replacing the preset asset or changing the active preset invalidates that prefix.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The bundle does not copy preset assets into DSH home; deployment owns that file operation for the isolated profile.
- The preset supplies guidance only. Gateway admission, calendar source policy, memory repository policy, and approval behavior remain enforced by their owning packages.
- No runtime invariant companion is supplied: the package ships static preset assets and a profile patch, with no runtime state of its own.
