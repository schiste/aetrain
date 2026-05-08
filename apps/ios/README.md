# iOS Client

This directory is reserved for the future native iOS client.

Planned stack:

- Swift
- native Apple UI stack
- Rust core via bindings

Rules:

- iOS-specific UI and platform integration live here
- routing, graph logic, search, and codecs should come from the shared Rust core
- this app should never become the only place where product logic exists
