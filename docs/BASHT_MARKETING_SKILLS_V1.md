# BASHT Marketing Skills v1 — review and deployment plan

## Scope
Ten standalone, Arabic-first, read-only-by-default OpenClaw Agent Skills:
`basht-market-intelligence`, `basht-marketing-strategy`, `basht-creative-direction`,
`basht-social-media`, `basht-ads-campaigns`, `basht-performance-analytics`,
`basht-video-creative`, `basht-local-seo`, `basht-conversion-optimization`,
`basht-marketing-automation`.

These teach workflows and do **not** supply Ads, social publishing, GA4, image or video API access.
Run `node --test scripts/marketing-skills.test.mjs` from repo root.

## Architecture
- This repository is the live OpenClaw **image source**, unlike the separate safwan-smart-assistant application.
- Dockerfile already copies `skills/` into `/app/skills`.
- Production workspace resides at `/data/workspace`, backed by the existing Railway `openclaw-volume`.
- Current `skill-sync.sh` **rejects these ten names**; it only permits basht-daftra and basht-accounting.
- **Do not merge this branch to main to test**. Main can trigger production deployment. These files alone do not get installed on /data.
- Do not alter `skill-sync.sh`, `entrypoint.sh`, `Dockerfile`, or OpenClaw/Gateway/Claude config in this PR.

## Installation follow-up (separate, owner-approved PR)
1. Inspect `entrypoint.sh` call sites of `skill-sync.sh` and live skill inventory; check for collisions and symlinks.
2. Design a manifest-restricted marketing installer that accepts only the ten exact basht-* names, validates their frontmatter and UTF-8, and uses staged atomic swaps/backups. Never overwrite owner-modified workspace skills silently.
3. Test installer on temporary synthetic workspace including rollback, missing source, pre-existing destination, symlink refusal, crash recovery, double invocation, and file permissions.
4. Request owner approval for service build/deployment. Take a dated backup of target skill directories, never production secrets.
5. After approval, deploy using the existing /data volume, verify 10 skill discovery results on the live pinned OpenClaw version and unaffected Daftra/accounting skills; check logs for errors. Roll back the installer or restore backups on failure.
6. Confirm user interaction via **WhatsApp**: market analysis (no search tool available), campaign plan (no account), zero unexpected writes/charges. Record proofs.

## Acceptance matrix
- 10 distinct names, same name as folder, YAML frontmatter, nonempty description: static checks.
- Each skill has source transparency, no invented results, owner-approved writes/spend, no secrets, and report structure: static checks plus scenario reviews.
- Market Intelligence: test on synthetic competitor prices (no invented external facts).
- Analytics: zero denominators, attribution caveat, incomplete data and SAR currency.
- Social/Ads/Automation: absent connector must stop at drafts/plan, never dispatch or spend.
- Visual/Video: missing generation tool returns brief/storyboard; no false file-created claims.
- SEO/CRO: public review only, no changes to public business accounts or storefront without approval.
- Live acceptance only after authenticated installation and verified skill discovery. This PR **is not deployed or activated**.

## Ownership
ChatGPT develops and reviews; Claude Code may independently audit. BASHT runtime is the final acceptance system. Agents can be split later with these same skills.
