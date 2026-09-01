# Files

- [Event Domains and Lifecycle Events](events.md) - The three event domains of the DeepSeek Harness (session, agent, capability), the durable/live split, event modes, the session event envelope, and the generated event catalogs.
- [Plugin Architecture and Composition](overview.md) - The Cordis everything-is-a-plugin foundation of DeepSeek Harness, profiles and bundles layering, host vs agent-preset composition planes, and the singleton application launcher.
- [Capability Seams](seams.md) - The seam pattern of DeepSeek Harness — a swappable capability with a Service Definition, Service Provider and Consumer — and the seams that let a single provider swap change the whole product.
- [Session, Step and Turn Lifecycle](turn-flow.md) - The agent-loop lifecycle of DeepSeek Harness — a step is one model request plus the tools it calls, a turn is zero or more steps, and the session log is the single source of model context.
