# Agent Note: llm-pi-ai empty-compat merge regression

Status: implemented

English | [中文](2026-09-12-llm-pi-ai-empty-compat-merge-regression.zh.md)

## Problem

The upstream 0.1.5-rc.1 merge reverted the array-aware emptiness filter in `configuredCompatEntries` (`packages/llm/llm-pi-ai/src/catalog.ts`). The settings schema materializes an absent `compat` as its empty values — `allowedFallbackModels: []`, `chatTemplateArgs: {}`, `chatTemplateKwargs: {}` — and the post-merge filter skipped only empty objects, so an empty array made a route look like it configured `allowedFallbackModels`. A hand-declared `openai-completions` route whose settings omit `compat` (the local vLLM endpoint in this deployment) was then rejected with `sets compat "allowedFallbackModels", but no model on the route speaks a protocol that takes it; it exists on anthropic-messages`. The provider never registered, its section vanished from the model picker, and the session default model failed every turn with `INVALID_CONFIG`. The in-tree regression test (`ignores schema-materialized empty compat defaults a protocol does not take`) failed at the merge head.

## Decision

Restore the pre-merge filter: an empty array and an empty object are both *no switch*, and the field falls through to the next layer — the installed catalog entry, then pi-ai's own detection — exactly like an absent key. The regression test now passes, along with the rest of the hand-declared provider suite.

The merge also added an upstream test asserting `allowedFallbackModels` is withheld as catalog-owned. That premise conflicts with the fork surface: both before and after the merge, `ANTHROPIC_COMPAT_GATE` marks `allowedFallbackModels` as `offer` for `anthropic-messages` (it is configurable there, with the schema validating the array shape), while `supportsMidConvoEffort` is withheld. The test now pins the actual contract: `supportsMidConvoEffort` is refused with `which is not configurable here`; `allowedFallbackModels` round-trips on `anthropic-messages` and is refused on `openai-completions` with `no model on the route speaks a protocol that takes it`.

## Alternatives considered

**Treat empty arrays as configured.** This was the post-merge behavior and produced the regression; an empty list carries no switch, exactly like an absent key, so it must not reject a route.

**Adapt the upstream test outright (keep withholding `allowedFallbackModels`).** Rejected: the fork surface predates the merge — `ANTHROPIC_COMPAT_GATE` has offered `allowedFallbackModels` on `anthropic-messages` since pi-ai 0.85.1 landed in the fork, and the config schema validates its array shape. Withholding it to satisfy an upstream test would remove a documented capability.

**Change the schema so `true` fails with the catalog message.** Rejected: the type mismatch is a schema-boundary error by design; the catalog's `which is not configurable here` wording is for fields the schema deliberately does not know.

## Consequences

Hand-declared routes without compatible `compat` register again, so the local provider reappears in the model picker and the configured default model serves. No schema, wire, or settings-format change; the fix restores behavior the fork shipped before the merge. The runtime loads the built `lib/` bundle, so a `build:lib:host` is required for a running deployment to observe it.

## Testing

`packages/llm/llm-pi-ai/tests` passes 326/326; the catalog regression case and the adapted compat-upgrade contract are both in the suite.
