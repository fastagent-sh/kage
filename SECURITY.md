# Security policy

## Supported versions

kage is pre-release. There are no release lines yet: security fixes land on `main`, and the app is
built from it (`npm run package`). Build from the latest `main` to receive fixes.

## Reporting a vulnerability

Do not open a public issue for a security report.

Use GitHub's private vulnerability reporting: open the repository's **Security → Report a
vulnerability** form (`https://github.com/fastagent-sh/kage/security/advisories/new`).

Please include:

- the affected commit, and your OS, Electron and FastAgent versions,
- a minimal reproduction or proof of concept,
- the impact you observed,
- any suggested remediation.

Do not attach credentials, private conversations, project contents or an exploit containing such
data. We aim to acknowledge a report within 5 business days and to provide a remediation timeline
after triage. Please give us a reasonable window to ship a fix before any public disclosure.

A vulnerability in FastAgent itself (the runtime, its channel adapters, its credential resolution)
belongs to [FastAgent's security policy](https://github.com/fastagent-sh/fastagent/security/policy).

## Scope

In scope:

- Electron main/preload/renderer isolation and navigation boundaries.
- Credential selection, storage access, OAuth handling and accidental disclosure.
- Agent, scaffolding and registry operations that can overwrite or expose data.
- Session/control isolation, cross-conversation data leakage and unsafe replay of tool work.
- Repository automation that can expose secrets or execute untrusted PR code with write access.

Out of scope:

- what an agent is authorized to do: agents execute the tools they are given and may modify the
  directories they work on. Stopping a run is not rollback, and author-controlled tools are not
  sandboxed by this client. Report a bypass of kage's trust boundaries, not a declared capability;
- third-party model providers and their availability;
- issues that require a compromised local machine or leaked secrets you control.

## Handling secrets

- kage keeps provider credentials in its own `auth.json` in its user data directory
  (`~/Library/Application Support/kage/` on macOS) and never in an agent's directory.
- No CI job reads a developer's auth file or uses real model credentials; tests use isolated
  fixtures and fake model endpoints.
- If a credential is exposed, revoke or rotate it at the provider rather than merely deleting it
  from an issue or a Git commit.
