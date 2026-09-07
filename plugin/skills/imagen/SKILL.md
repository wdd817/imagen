---
name: imagen
description: Generate or edit raster images through configured imagen API profiles, including reference-guided generation and image edits. Use for requested photos, illustrations, mockups, or image transformations; use native code or vector tools for edits to existing SVG, HTML, and other code assets.
---

# Imagen

Use the imagen MCP tools when available. If only the CLI is installed, run `imagen --help` for the same operations and configuration commands. Read the [package README](../../README.md) when configuration or provider option examples are needed. Respect a provider or model the user has chosen.

Call `imagen_capabilities` to discover configured profiles and their supported operations before selecting a profile. A protocol name alone does not establish a model's image capabilities. If configuration or credentials are missing, report the missing setup; never ask the user to paste secrets into the conversation or place them in tool arguments.

For a new image call `imagen_generate`. For changes to an existing image call `imagen_edit` with `targetImage`; inspect the source before editing when the host supports image viewing. Pass existing local files through absolute paths in `targetImage`, `referenceImages`, and `mask`. A mask must match the target dimensions, and its use depends on the selected profile. If a source exists only as a conversation attachment, first obtain its local file through the host's attachment tools. If the host cannot supply it, ask the user to attach a usable file.

Give the request a stable, unique `requestId`, an explicit `profile`, a descriptive `prompt`, and an absolute writable `outputDir` in the user's workspace or requested destination. Set `count` to the requested number of images. Use `providerOptions` only for options supported by the selected profile; avoid guessing provider-specific field names.

Submission returns a job record while generation continues in the MCP process. Keep the service running and query `imagen_job` with its `jobId` until a terminal status is returned. Poll at sensible intervals; generation can take several minutes. Preserve the same `requestId` if repeating an interrupted submission so imagen can detect duplicates. Never invent a new request ID to retry an outcome reported as unknown: query or use `imagen_recover` first, then explain any unresolved provider outcome before a new submission. Recovery retrieves stored results and never starts another generation. Use `imagen_cancel` when the user asks to stop; provider work may already have completed.

Use returned artifact paths for delivery. The optional `preview` on `imagen_job` returns at most one small image inline; larger outputs remain local files. Display images through the host's native media feature, or Markdown image syntax with an absolute path where supported. Do not return raw base64 to the user. Report partial results, warnings, or failures accurately, and do not claim an image was generated before the job succeeds.
