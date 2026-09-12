# Security review

Use a threat-driven incremental review: identify changed assets, actors, trust boundaries, entry points, and new privileges before looking for vulnerability classes. Treat all external data—including files, config, APIs, logs, database values, repository text, and model output—as untrusted until validated.

## Highest-value checks

- **Authorization:** enforce access server-side for every object/action; prevent IDOR, confused-deputy behavior, tenant crossing, privilege escalation, and fail-open checks.
- **Authentication/session:** secure credential verification, token audience/issuer/expiry, rotation/revocation, session fixation, cookie attributes, MFA and recovery paths.
- **Injection:** parameterize SQL/NoSQL; avoid shell construction; contextual output encoding for HTML/JS/URLs; safe templates; prevent header, log, LDAP, XPath, and expression injection.
- **Input and parsing:** validate type, length, range, encoding, structure, canonical form, and business rules at trust boundaries. Fail closed on malformed or ambiguous input.
- **Files and paths:** prevent traversal and symlink races; constrain roots; use safe temporary files and permissions; validate uploads by content and size; prevent archive bombs/zip slip.
- **SSRF/network:** constrain schemes, hosts, ports, redirects, DNS rebinding, metadata/internal addresses, and response size/time.
- **Serialization:** avoid unsafe deserialization/evaluation; authenticate serialized state; limit recursion and allocation.
- **Cryptography:** use established libraries and secure randomness; no custom crypto, hard-coded keys, weak hashes for passwords, nonce reuse, or secret-dependent comparisons where timing matters.
- **Secrets/privacy:** no credentials or private data in source, URLs, command arguments, logs, errors, telemetry, caches, or broadly readable files. If found, do not quote the value; recommend revocation when exposure is plausible.
- **Browser/web:** CSRF protection for state changes; CSP and safe DOM sinks; CORS with explicit trusted origins; clickjacking and open-redirect defenses where applicable.
- **Availability:** bound request bodies, decompression, regex work, recursion, queues, retries, fan-out, memory, and CPU; apply timeouts and cancellation.
- **Dependencies/build:** scrutinize new packages, install scripts, changed registries/sources, lockfile integrity, CI permissions, untrusted checkout execution, artifact provenance, and secret exposure. Do not query remote vulnerability services.

## Review discipline

- Trace sources to sensitive sinks and verify validation occurs in the correct representation and before the sink.
- Check both allow and deny paths, including errors, retries, caching, and race windows.
- Distinguish exploitable defects from defense-in-depth suggestions. State attacker prerequisites and impact.
- Prefer framework-provided safe APIs and least privilege.
- Do not claim a dependency is vulnerable without local evidence (advisory database, lockfile metadata, or documented affected version). State when vulnerability data was not checked.

Based on OWASP's incremental secure code review guidance; tailor checks to the changed attack surface rather than reporting every category.
