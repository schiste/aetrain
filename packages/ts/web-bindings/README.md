# Web Bindings

This package namespace is reserved for thin TypeScript wrappers around wasm or
other generated bindings from the shared Rust core.

Rules:

- Keep browser glue here.
- Keep business logic in `packages/rust/`.
- Do not fork route, URL, or normalization logic into TypeScript unless there
  is a temporary migration reason and it is clearly documented.
