# Userland native app sources

This repository contains the public client source and selected native Worker reference. Hosting follows the selected Account's current admission and usage policy. Bounded internal fixtures and separately approved, funded managed hosting have distinct admission gates; this repository does not enable either or grant provider credentials.

Start with https://docs.userland.fun/native-guide.md. The five core operations are context.get, apps.get, apps.apply, apps.run and operations.get. Use current Account capabilities instead of assuming that builds, browsers, bindings or a source transport are configured.

- [Native notes and private attachments](examples/native-notes/README.md)
- [Native CLI workflow](cli/NATIVE_WORKERS.md)
- [Agent skill](.agents/skills/userland-native-app/SKILL.md)
- [Machine-readable selected examples](catalog.json)

The source CLI can be built with the repository toolchain. Current CI runs Node.js22; use that version for the supported source workflow. Other Node versions are not claimed verified by this repository. The native CLI release is versioned separately from plugin and marketplace distribution. Source changes do not themselves publish any artifact; use the CLI README for its version and installation instructions.

Read-only connections can inspect permitted metadata and source. Raw browser diagnostics, runtime logs and data queries need full publishing access. Secret values use protected entry or generated requirements, never model transcripts. Disconnecting a connector does not revoke independent API keys.

Archived materials are historical implementation references, not supported examples or active agent instructions. They must not be used to infer native capabilities.
