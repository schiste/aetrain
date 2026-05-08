# Shared Packages

`packages/` contains reusable code that should outlive any single app surface.

Namespaces:

- `rust/`: shared performance-critical core
- `ts/`: thin browser-facing bindings and wrappers

Rules:

- shared business logic belongs here, not inside `apps/`
- language choice follows boundary choice: Rust for core, TypeScript only where the browser requires it
