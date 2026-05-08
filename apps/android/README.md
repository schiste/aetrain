# Android Client

This directory is reserved for the future native Android client.

Planned stack:

- Kotlin
- native Android UI
- Rust core via bindings

Rules:

- Android-specific UI and platform integration live here
- routing, graph logic, search, and codecs should come from the shared Rust core
- this app should never become the only place where product logic exists
