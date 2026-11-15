# Inactive Mail judgement bindings

The `adapter-actions/` generation also declares the Mail judgement capabilities from Cortex v6.32.0 (`mail.judgement.*`): Unimportant, Block domain, triage corrections, Not phishing, snooze, snooze cancel, waiting and Undo. `src/adapter/judgements.ts` composes the canonical declaration and registers one connector per capability.

Undo marking is exported as `JUDGEMENT_UNDO`: every capability has an Undo except `undo` itself, and `correct` has one only for move corrections (the host decides per correction). A capability with an Undo names `mail.judgement.undo` as its compensation.

The adapter keeps no judgement state. Each dispatch is passed unchanged to the host's `mailJudgements.changeJudgement`, and the host's result is returned. A host without `mailJudgements` gets connectors with no support declaration and no dispatch, so every judgement is unavailable and nothing falls back.

`bun run probe:judgements` lists the declared capabilities and runs one change and its Undo against an in-memory fake host store. The pinned conformance kit has no public judgement scenario runner, so the probe does not exercise Cortex's real judgement store.
