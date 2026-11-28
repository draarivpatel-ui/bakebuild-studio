# Security policy

BakeBuild Studio is a zero-dependency local CAD workbench that generates deterministic STEP and STL geometry in the browser or Node.js.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest `main` | yes |

## Reporting a vulnerability

Report suspected security vulnerabilities privately through GitHub's security advisory form:

https://github.com/draarivpatel-ui/bakebuild-studio/security/advisories/new

Do not open a public issue for a security problem. Include the affected model or file, the browser or Node.js version, steps to reproduce, and any malformed input involved. Redact personal or manufacturing-sensitive information before reporting.

We aim to acknowledge reports within 3 business days, complete an initial triage within 14 days, and release a fix or mitigation within 90 days when a report is confirmed. Please keep the report private while coordinated disclosure is underway.

## Scope

In scope are unsafe DOM injection paths, unexpected network access, prototype pollution or parser confusion in the CAD engine, malformed export generation that crosses a security boundary, and repository or workflow misconfiguration. Manufacturing suitability, food-contact certification, and printer safety are engineering validation topics rather than security vulnerabilities.
