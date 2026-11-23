# BASHT transport ↔ marketing compatibility review (2026-11-22)

## Compared branches
- Transport: `feature/basht-transport-sales-v1` — draft PR #32.
- Marketing: `feature/basht-marketing-skills-v1` — draft PR #29 (10 skills).
- Production source: `main` of `safwan5001-source/openclaw-railway-template`.

**Status: static cross-branch review only; not a successful end-to-end or production test.** Neither unmerged branch constitutes an installed skill in the Railway volume.

## Verified differences and risks
| Area | Finding | Required gate |
|---|---|---|
| Names and directories | Transport uses `skills/basht-transport-sales`; marketing uses ten other names. No same-directory collision among changed files. | Test OpenClaw discovery for all eleven skills in an isolated workspace |
| Shared file | Both PRs change `package.json` and specifically its `scripts.test`. The later merge could accidentally remove tests from the earlier branch. | Merge on current main and preserve both `scripts/marketing-skills.test.mjs` and `skills/basht-transport-sales/scripts/*.test.mjs` |
| Installer | Transport edits existing `skill-sync.sh` allowlist and `entrypoint.sh`; marketing PR explicitly does not modify them and plans a separate manifest-restricted installer. | Design one controlled manifest/installer or prove coexistence with atomic swaps, backups and no silent overwrite |
| Runtime state | Both expect OpenClaw workspace under `/data/workspace/skills`. | Test idempotency, symlink refusal, existing modified skill, rollback and restart safety on temporary data |
| Permissions | Both disallow unauthorized outbound messages, campaign publishing and spending. | Validate refusal with synthetic user prompts and disconnected connectors |
| Commercial handoff | Transport qualifies potential customer need; marketing designs draft campaigns. | Exchange only approved business brief and anonymized/authorized data; neither skill executes external action just because another generated a draft |
| CI | Transport workflow exists on PR #32; no successful run reported for the transport commit in the connector. | CI tests and deployment-independent acceptance are required; do not interpret missing runs as PASS |
| Version alignment | Production pins OpenClaw 2026.10.9. | Prove eligibility/discovery against this version; don't change model or Gateway configuration |

## Deployment sequence
1. Independently test both branches. Do not merge either for the sake of testing.
2. Reconcile shared `package.json` changes and installer design on a **new integration branch** based on the then-current main, preserving both test suites.
3. Run shell syntax, unit tests, packaging and installation tests against a synthetic temporary workspace. Confirm all eleven names are discoverable and both Daftra and accounting retain their current behavior and eligibility rules.
4. Review diff for config changes or implicit deployment; request explicit owner approval before merging runtime-changing files or deploying on Railway.
5. Once approved, back up only affected skill directories, roll out safely, and confirm live discovery and logs.
6. Sales outreach, posting and ad spend remain blocked without separate owner approval.

## Separations
- Transport: lead sourcing, evidence classification, route/vehicle suitability, nonbinding quote calculations, draft sales brief.
- Marketing: content, strategy, ads plans, channel performance — no unapproved publishing or spending.
- Daftra/accounting: existing separate skill behavior; regression-only concern.

## Immediate blockers
- Real fleet register (number, permitted capacity, truck types, readiness, costs) missing.
- GitHub CI proof for PR #32 missing.
- Cross-branch merged-package and installer simulation has not passed.
- No automatic monitoring, external outreach or production skill activation authorized.
