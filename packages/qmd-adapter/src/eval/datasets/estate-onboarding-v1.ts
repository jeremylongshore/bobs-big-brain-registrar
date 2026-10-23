import type { EvalDataset } from '../eval-types.js';

/**
 * estate-onboarding-v1 — questions a new hire asks about how Intent Solutions
 * runs. Current-answer and still-searchable obsolete-answer labels identify the
 * sources a new hire can act on correctly or wrongly (for example, a
 * torn-down platform, a renamed repo, a retired channel). Scored with FAMA@10
 * (bead compile-then-govern-39z.5): Recall@10 cannot see a brain that serves the
 * right answer next to a wrong one; FAMA subtracts for it.
 *
 * Labeled from estate authority first (the CLAUDE.md files, intent-os ops/,
 * the umbrella 000-docs), then matched to docs in kb-export by reading them —
 * not by searching until something hit. `obsolete` holds only docs a new hire
 * could act on wrongly; off-topic noise and docs framed as history are not
 * obsolete. A question no current doc answers is a documentation hole, kept
 * in ESTATE_ONBOARDING_V1_GAPS instead of being scored.
 *
 * Labels were drawn while the dense arm was down (embedder stopped
 * 2026-10-10..13), so earlier `notes` ranks are lexical-only. Dated dense-audit ranks below
 * are separate observations. The relevant labels
 * do not depend on search; an obsolete doc that only dense retrieval surfaces
 * may still be unlabeled. The 2026-10-23 audit adds seven query-specific
 * obsolete labels from local top 10 with dense configured. The later 39z.33/33.3
 * pass replaces seventeen mixed-current originals using fifteen accepted corrections
 * (some reused), with query-specific obsolete labels. The same scored question ids,
 * kinds and literal queries are retained. Labels were adjudicated before observing
 * new retrieval results; annotation effects are reported separately from ranking.
 * Methodology and authority links: ./README.md.
 */
export const ESTATE_ONBOARDING_V1_DATASET: EvalDataset = {
  name: 'estate-onboarding-v1',
  idSpace: 'qmd:// citation',
  queries: [
    {
      id: 'e01',
      kind: 'semantic',
      query: 'how do I deploy to production',
      relevant: [
        'qmd://kb-guides/8bb364ff-b970-5736-a173-5af5b0051e2f.md',
        'qmd://kb-guides/87f17c55-94ae-5be9-b68f-bf536e9b8190.md',
        'qmd://kb-curated/dce1f285-471c-5a27-ace6-9458810c7b7d.md',
      ],
      notes:
        'Relevant not in top 10 (probe returns only 4 hits: #1 deploy-vps.sh reset-only decision 5ff7ac4a is true but narrow \u2014 now-lms/intent-os box updates, not the general pipeline; #2-4 LangGraph/web-app noise). Correct answer = GitHub Actions -> Tailscale OIDC -> per-repo force-command on the VPS (ops/deploy). 39z.28 (2026-10-16): 4ffcb275 (said `secrets: inherit`) rewritten as dce1f285 with the explicit-secrets rule and added as relevant; the coastal-realty-ops CLAUDE.md (Cloud Run) was rewritten as b1484cf6 and the original archived, so the obsolete label is gone.',
    },
    {
      id: 'e02',
      kind: 'semantic',
      query: 'where is production hosted',
      relevant: [
        'qmd://kb-guides/f1abddca-3ccc-566f-b7e4-3c02986e8907.md',
        'qmd://kb-decisions/44854c16-ae8b-5fb7-9273-df9686690b9d.md',
        'qmd://kb-guides/ec4be0fe-fb06-5808-ad93-77764983d5cd.md',
      ],
      obsolete: ['qmd://kb-guides/26fad4c1-a939-53e9-b81d-beb7585fb13d.md'],
      notes:
        "Relevant not in top 10; probe top 10 is LangGraph 'Deployment Options', DiagnosticPro CLAUDE.md, Hustle summary etc. \u2014 noise. e945e2cc (correct on host, stale Slack line) rewritten as f1abddca in 39z.28. Obsolete (not in top 10): Domain audit 26fad4c1 says 11 domains pending migration and jeremylongshore.com stays on Netlify/Firebase.",
    },
    {
      id: 'e03',
      kind: 'semantic',
      query: 'how do I get SSH access to the production server',
      relevant: [
        'qmd://kb-guides/9ac7783e-c711-53f7-925e-7613c4936253.md',
        'qmd://kb-guides/3da6addc-b68e-566a-aaee-797742ac4592.md',
      ],
      obsolete: ['qmd://kb-guides/96e801bc-35d9-5a95-a8b2-a7bd6bfe3bca.md'],
      notes:
        '2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. Old emergency guide recommends public SSH and local-only backup assumptions. Earlier probe notes retain their historical labels/ranks: Probe returned ZERO results. Ope onboarding packet (2a8fee37, rewritten as 9ac7783e in 39z.28): tailnet join is the prerequisite, no public SSH; security posture: SSH tailnet-only, pubkey-only. No obsolete doc found.',
    },
    {
      id: 'e04',
      kind: 'semantic',
      query: 'where are secrets stored and how do I decrypt them',
      relevant: [
        'qmd://kb-guides/a6ede975-d7e8-5e40-b5c4-89178b6b0142.md',
        'qmd://kb-curated/6243141f-aa38-4a4b-b3e7-87df102befc7.md',
      ],
      notes:
        'Probe returned ZERO results. Both docs state SOPS+age, encrypted files in git, decrypt via scripts/sops-env to /dev/shm only. No obsolete (no active doc tells you to use GCP Secret Manager/pass for estate secrets).',
    },
    {
      id: 'e05',
      kind: 'semantic',
      query: 'how do I add a new secret to a repo',
      relevant: [
        'qmd://kb-guides/a6ede975-d7e8-5e40-b5c4-89178b6b0142.md',
        'qmd://kb-curated/6243141f-aa38-4a4b-b3e7-87df102befc7.md',
      ],
      notes:
        'Relevant not in top 10 (probe: LangGraph Cloud SaaS, GitHub Pages, TEST_AUDIT, ADK, PR conventions \u2014 noise). Partial answer only: docs name sops-init bootstrap + encrypted file + never plaintext .env; none spells out `sops edit`/adding a key step by step. No obsolete found.',
    },
    {
      id: 'e06',
      kind: 'semantic',
      query: 'where do monitoring alerts go',
      relevant: [
        'qmd://kb-curated/599bc808-bef9-5b6f-95ed-538dd54c573f.md',
        'qmd://kb-curated/b4c91d39-52d7-5e5f-962e-86824c26cce1.md',
        'qmd://kb-curated/dce1f285-471c-5a27-ace6-9458810c7b7d.md',
        'qmd://kb-guides/42247e58-6791-5c1e-9307-98c59ac1cd16.md',
      ],
      obsolete: ['qmd://kb-guides/dad34032-e92d-5d64-85ff-3c4caf20de16.md'],
      notes:
        "Relevant at #1 (Catalyst monitor -> estate alert shim -> Buzz, never Slack, only high/urgent page) and #2 (estate alerting is delivered through Buzz). Both are indirect. 39z.28 (2026-10-16): the four Slack-era docs (4ffcb275, Ope onboarding, System Map, e945e2cc) were rewritten with the notify.sh -> alert-floor -> Buzz sys-* channel map and archived; the infra doc dce1f285 and system map 42247e58 are now relevant. Obsolete: #5 'Alert routing \u2014 intentsolutions VPS' (Slack-only).",
    },
    {
      id: 'e07',
      kind: 'semantic',
      query: 'how are backups done and where is the offsite copy',
      relevant: [
        'qmd://kb-curated/bcda8f6f-8ca3-5d86-92b1-a5d55677cc55.md',
        'qmd://kb-decisions/0c047fd4-2be6-5fcb-83c7-9be788c1c226.md',
        'qmd://kb-decisions/2d5be563-3f34-58ce-8dd2-4fb6e96a6211.md',
        'qmd://kb-guides/1f35d737-e247-54f0-b7fb-54d786cf3b2d.md',
      ],
      obsolete: [
        'qmd://kb-guides/0b44b9ea-60d5-5158-a94c-28d999ceb4d3.md',
        'qmd://kb-guides/4303332f-6f6d-5874-a2ca-2d72d6db7f74.md',
        'qmd://kb-guides/cd58e9ab-5cff-5b0f-b940-06d158b73e58.md',
        'qmd://kb-guides/9b7de37e-9c00-52a1-9336-e52d4c433d1d.md',
      ],
      notes:
        "Probe returned ZERO results. Relevant: three-tier borg (dev box / home server / B2 Object Lock), B2 provisioned with trimmed keys, Borg+rclone ADR; 39z.28 added the rewritten VPS recovery procedure 1f35d737 (replica, home server and B2 all live). Obsolete: ops/backup summary 0b44b9ea ('B2 is not provisioned'), the old VPS recovery procedure f658703a (off-site 'still pending', archived 2026-10-16), both runbook summaries (off-site deferred to a Hetzner Storage Box), 067-AACR (Epic 1.1 not implemented). Also stale: alert-routing doc claim 13.",
    },
    {
      id: 'e08',
      kind: 'semantic',
      query: 'how do I restore from a backup',
      relevant: [
        'qmd://kb-guides/1f35d737-e247-54f0-b7fb-54d786cf3b2d.md',
        'qmd://kb-curated/cb664dd7-ff9a-5209-95f2-d26df59933d6.md',
      ],
      notes:
        'Relevant not in top 10 (probe: Mission Control KPIs, Zava DB lab, Hustle status \u2014 noise). VPS recovery procedure (f658703a, rewritten as 1f35d737 in 39z.28) gives borg repo/passphrase locations + restore drill; off-estate doc shows full borg extract from the off-site copy. No doc covers restore-from-b2.sh. No obsolete flagged.',
    },
    {
      id: 'e09',
      kind: 'semantic',
      query: 'how do I change the reverse proxy config for a site',
      relevant: [
        'qmd://kb-guides/3f127438-735d-5ec8-9026-0930f4da63c7.md',
        'qmd://kb-guides/781a5b80-b29a-5df3-be17-5522f12e63e9.md',
      ],
      notes:
        'Probe returned ZERO results. Relevant: caddy validate (without sudo) then systemctl reload, never restart; VPS runbook CLAUDE.md states the /etc/caddy/Caddyfile validate+reload rule (other parts of it are stale: Slack-only). No obsolete found.',
    },
    {
      id: 'e10',
      kind: 'semantic',
      query: 'do we use Google Cloud',
      relevant: [
        'qmd://kb-decisions/44854c16-ae8b-5fb7-9273-df9686690b9d.md',
        'qmd://kb-guides/00655222-c6d3-5523-bd6c-e7bb088c1394.md',
      ],
      obsolete: ['qmd://kb-guides/4303332f-6f6d-5874-a2ca-2d72d6db7f74.md'],
      notes:
        "Probe returned ZERO results (query says 'Google Cloud', docs say 'GCP'). Relevant: GCP fully-exited decision + 'GCP exodus complete' onboarding note (947ef8b5, rewritten as 00655222 in 39z.28 with Workspace retired too). Obsolete: VPS Runbook Summary ('GCP exodus partially complete, ~27 zombie projects'); the coastal-realty-ops CLAUDE.md (Cloud Run) was rewritten as b1484cf6 and archived.",
    },
    {
      id: 'e11',
      kind: 'lexical',
      query: 'do we use Netlify for websites',
      relevant: ['qmd://kb-decisions/d0ecdf22-ea24-5bd3-9aab-fcae3660cf25.md'],
      obsolete: [
        'qmd://kb-guides/2ef53ed6-d55a-5ea6-bf32-a73cce3d596e.md',
        'qmd://kb-guides/6b383bfa-1f20-5c60-9173-6b2ea7e62c8e.md',
        'qmd://kb-guides/31cf8803-ef48-5ba3-b5db-e353d6deddbe.md',
        'qmd://kb-guides/215d695b-e78b-5aab-95e1-6807d081c71a.md',
        'qmd://kb-guides/26fad4c1-a939-53e9-b81d-beb7585fb13d.md',
      ],
      notes:
        "Netlify-retired decision not in top 10; #1 jeremylongshore.com README is consistent (migrated off Netlify) but only covers one site. Obsolete: #4 Website Audit exec summary ('deployed on Netlify'); not in top 10: StartAI Tools CLAUDE.md ('auto-deploys to Netlify'), Multi-Blog Workspace CLAUDE.md, blog workspace overview, Domain audit. #2/#3/#5/#6 are changelogs/history \u2014 noise, not obsolete.",
    },
    {
      id: 'e13',
      kind: 'lexical',
      query: 'what CI checks must pass before merging',
      relevant: [
        'qmd://kb-guides/2b16bd66-200c-5afd-8472-ca89bdd146de.md',
        'qmd://kb-curated/004b9ba8-8db2-5a29-9a73-d875afa87dd3.md',
      ],
      obsolete: ['qmd://kb-guides/9fd70dbb-8a7d-539a-9149-5e7a28963a00.md'],
      notes:
        '2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. Old merge standard says protection is absent and plugin lacks its current unit gate. Earlier probe notes retain their historical labels/ranks: Relevant at #1 (013-OD-STND PR conventions); 20fd0fe9 and 004b9ba8 (required CI checks are the deterministic gate, AI reviewer advisory, never --admin-bypass) not in top 10. None lists the concrete check set (Codecov, CodeQL, mutation, lint, typecheck, harness verify). No obsolete.',
    },
    {
      id: 'e14',
      kind: 'lexical',
      query: 'how do Plane, Twenty and Umami get updated',
      relevant: [
        'qmd://kb-guides/79f4778a-8eaf-5255-8c95-55a4b97e236e.md',
        'qmd://kb-curated/dce1f285-471c-5a27-ace6-9458810c7b7d.md',
        'qmd://kb-guides/781a5b80-b29a-5df3-be17-5522f12e63e9.md',
      ],
      notes:
        'Probe returned ZERO results. All three state Watchtower auto-updates Plane/Twenty/Umami and no custom CI/CD for them (4ffcb275 rewritten as dce1f285 in 39z.28). No obsolete.',
    },
    {
      id: 'e15',
      kind: 'semantic',
      query: 'what is the dev box and what runs on it',
      relevant: [
        'qmd://kb-guides/8b668d91-6e39-5dc9-adbe-d3d6502352b6.md',
        'qmd://kb-guides/f6fe25e6-ba1e-54b6-b7e8-2ba58ee54d9f.md',
        'qmd://kb-guides/9ac7783e-c711-53f7-925e-7613c4936253.md',
      ],
      notes:
        "Relevant not in top 10 (probe top 10 is Catalyst/automations/intent-os changelog noise). Relevant docs are 'contradiction' records that still state current facts: zero production containers on the dev box, Caddy only for demos static files; Ope packet gives the dev box vs prod VPS topology. No doc names it 'team-server' or lists Dolt/MCP/Claude sessions.",
    },
    {
      id: 'e17',
      kind: 'semantic',
      query: 'where is company email hosted',
      relevant: [
        'qmd://kb-guides/f66d24d8-30ab-5d63-b37a-dba8efbf6fea.md',
        'qmd://kb-decisions/ffbd1e78-270c-5364-a770-46545d23376a.md',
        'qmd://kb-guides/00655222-c6d3-5523-bd6c-e7bb088c1394.md',
      ],
      obsolete: [
        'qmd://kb-guides/cd58e9ab-5cff-5b0f-b940-06d158b73e58.md',
        'qmd://kb-guides/9bb2091e-cce3-5b6e-9730-2d66695a2745.md',
      ],
      notes:
        "Relevant not in top 10 (only hit: #1 StartAI Tools CLAUDE.md \u2014 noise). Relevant docs: 'the Intent Solutions MXroute mailboxes are for 1:1 correspondence' + the Google->MXroute hard-switch decision, and since 39z.28 the rewritten exodus note 00655222 ('Company email is MXroute'). Obsolete (not in top 10): intentsolutions-vps-runbook ('email handled via Google Workspace'), Email Authentication doc (Google Workspace DKIM). The two 'Google Workspace still used' docs (947ef8b5, ca5bbd29) were rewritten and archived 2026-10-16.",
    },
    {
      id: 'e19',
      kind: 'lexical',
      query: 'where is the shared calendar',
      relevant: [
        'qmd://kb-curated/b206b680-ed7a-5055-90c0-d23649331df2.md',
        'qmd://kb-curated/2a48c404-33f7-515f-881c-f1b703219c4a.md',
      ],
      obsolete: ['qmd://kb-curated/0a55ea2c-d00f-508c-8e66-b16243ca6fa7.md'],
      notes:
        "2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. Old calendar summary prescribes two collections per user instead of the shared-team layout. Earlier probe notes retain their historical labels/ranks: Relevant not in top 10; #1 'Calendar write authority is a property of the collection' is on-topic but doesn't say where. Relevant: Radicale CalDAV at calendar.intentsolutions.io, shared 'team' account. No obsolete.",
    },
    {
      id: 'e20',
      kind: 'lexical',
      query: 'how do I access the CRM',
      relevant: [
        'qmd://kb-guides/e6d325b6-448c-508d-b939-e88a86384da3.md',
        'qmd://kb-guides/9fa49f4a-cb1f-53c4-9c0f-d06a15079324.md',
      ],
      notes:
        "2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. The replacement preserves this question’s useful answer; unrelated stale clauses do not by themselves justify a query-specific obsolete label. Earlier probe notes retain their historical labels/ranks: Probe returned ZERO results. Twenty CRM at crm.intentsolutions.io (self-hosted on the VPS); e5ee0f94 still says SMTP via Jeremy's Gmail (stale detail, off-question). No obsolete.",
    },
    {
      id: 'e21',
      kind: 'semantic',
      query: 'how is DNS managed',
      relevant: [
        'qmd://kb-guides/c7c0f24a-03a8-5b3a-8e75-285145547bb7.md',
        'qmd://kb-curated/4312ea30-5932-5e30-b5fd-0af93cf52cac.md',
      ],
      obsolete: ['qmd://kb-guides/dd3f92bc-194f-5dd2-87fe-9b40cbe73d81.md'],
      notes:
        '2026-10-23 dense audit: dd3f92bc rank 10 prescribes Google-hosted Hustle DNS; current apex/www resolve to the VPS. Earlier lexical-only observation: Relevant not in top 10 (probe: coastal-realty summary, IEP blueprint, Phase F AAR \u2014 noise). Porkbun via sops-wrapped ops/dns scripts. Partial: no doc states the change procedure in ops/dns/README. No obsolete.',
    },
    {
      id: 'e22',
      kind: 'semantic',
      query: 'how does the jeremylongshore.com website deploy',
      relevant: [
        'qmd://kb-guides/41e58242-b3ee-53c5-af7b-bc4aa9e38a12.md',
        'qmd://kb-decisions/44854c16-ae8b-5fb7-9273-df9686690b9d.md',
      ],
      obsolete: [
        'qmd://kb-guides/0d239fc3-e329-569c-af12-6ddf2c001d43.md',
        'qmd://kb-guides/2a1df12b-35c1-5d1a-b8a6-cc15ca3127c6.md',
        'qmd://kb-guides/26fad4c1-a939-53e9-b81d-beb7585fb13d.md',
        'qmd://kb-guides/215d695b-e78b-5aab-95e1-6807d081c71a.md',
        'qmd://kb-guides/31cf8803-ef48-5ba3-b5db-e353d6deddbe.md',
        'qmd://kb-guides/a2bc9ef3-666c-584e-859c-47e89c5dc5c1.md',
      ],
      notes:
        "2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. Old site guide prescribes the retired Linkyee/static build. Earlier probe notes retain their historical labels/ranks: 2026-10-23 dense audit: 2a1df12b rank 2 and 0d239fc3 rank 6 prescribe retired Linkyee/static deployment; current site is Next.js/Docker. Gold a2bc9ef3 also mixes obsolete deployment with valid VPS facts; its replacement is pending 39z.33, so this remains an optimistic gold set. Earlier lexical-only observation: Probe returned ZERO results. Relevant: README (GitHub Actions + Tailscale OIDC + force-command to VPS, off Firebase/Netlify 2026-06-20); GCP decision confirms the move. Obsolete: Domain audit ('jeremylongshore.com will remain on Netlify/Firebase'), blog workspace overview + Multi-Blog CLAUDE.md (Netlify deploys from main).",
    },
    {
      id: 'e23',
      kind: 'lexical',
      query: 'how do I join the tailnet',
      relevant: [
        'qmd://kb-guides/f8322014-3c38-5e65-8a8e-ca83a723f79e.md',
        'qmd://kb-guides/323b8b4a-ac23-5df9-96ab-f99caf58dbdb.md',
      ],
      notes:
        "Relevant not in top 10 (only hit: internal testing dashboard DR-RFC \u2014 noise). f8322014: accept the invite with passkey/current IdP and pick the Intent Solutions tailnet; Workspace identity is retired. 39z.28: the install guide 668bb4ee (prereq 'Tailscale signed in with the Workspace identity') was rewritten as 323b8b4a (join from the team invite, any login) and archived, so it moved from obsolete to relevant.",
    },
    {
      id: 'e24',
      kind: 'semantic',
      query: 'the dev box disk is full, what can I safely delete',
      relevant: [
        'qmd://kb-guides/cfaa1f1b-d152-5e1e-86f3-ca11b8aa9a7c.md',
        'qmd://kb-guides/43580937-2f25-4070-bad6-4d3faa35590e.md',
      ],
      notes:
        'Probe returned ZERO results. Full-disk doc: reclaim ~/.cache/*, never /backup or ~/backups; home-dir guide carries the safety map (pnpm store, ~/.cache/borg). No obsolete.',
    },
    {
      id: 'e25',
      kind: 'semantic',
      query: 'how do I add a new app to the production server',
      relevant: [
        'qmd://kb-guides/8bb364ff-b970-5736-a173-5af5b0051e2f.md',
        'qmd://kb-guides/87f17c55-94ae-5be9-b68f-bf536e9b8190.md',
      ],
      notes:
        'Relevant not in top 10 (probe: LangGraph Cloud SaaS, MCP blog posts, Phase 5 AAR \u2014 noise). Onboard-a-repo procedure (per-repo OIDC trust, deploy key, 4 secrets, Caddy block, vps-deploy.yml). 39z.28: 4ffcb275 (`secrets: inherit`) was rewritten as dce1f285 with the explicit-secrets rule and archived; the rewrite states the deploy pattern, not the onboarding steps, so it is not labeled relevant here.',
    },
    {
      id: 'e26',
      kind: 'semantic',
      query: 'what is the commit message standard',
      relevant: [
        'qmd://kb-guides/2b16bd66-200c-5afd-8472-ca89bdd146de.md',
        'qmd://kb-curated/e5270cbd-2422-5cfa-9689-53f40702cffc.md',
      ],
      notes:
        '2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. Reuse the accepted current PR guide, deduplicate its citation, and preserve the unique Claude-specific attribution convention as a separate relevant citation. This label was adjudicated before observing new retrieval ranks. Earlier probe notes retain their historical labels/ranks: 013-OD-STND guide ranks #1; Branch/commit/PR discipline + Outsider Test (curated) not in top 10. 013 doc still names pre-rename repos (ICO/qmd-team-intent-kb) and says branch protection OFF, but the commit rules match v1.1. No obsolete hit in top 10; ranks 2-8 are other-project guides (noise).',
    },
    {
      id: 'e27',
      kind: 'semantic',
      query: 'what has to be in a pull request description',
      relevant: ['qmd://kb-guides/2b16bd66-200c-5afd-8472-ca89bdd146de.md'],
      notes:
        '2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. The replacement preserves this question’s useful answer; unrelated stale clauses do not by themselves justify a query-specific obsolete label. Earlier probe notes retain their historical labels/ranks: 013-OD-STND ranks #2 (Kobiton client CONTRIBUTING #1 = noise). 20fd0fe9 not in top 10. No obsolete hit.',
    },
    {
      id: 'e28',
      kind: 'semantic',
      query: 'how do I track my tasks',
      relevant: ['qmd://kb-curated/88a6a863-a182-5fc5-8c69-ac221b511188.md'],
      obsolete: [
        'qmd://kb-curated/41f458f7-cc65-58dd-bd55-af98c362e4eb.md',
        'qmd://kb-curated/83567b00-54fe-4f34-8bda-109221344025.md',
        'qmd://kb-curated/6dc4a43f-3b1e-577d-9b21-fffd78e35425.md',
        'qmd://kb-curated/c680061a-c46c-54fa-b954-4cbe38515b6a.md',
        'qmd://kb-curated/ae354749-eade-518b-81f9-13d954ff783f.md',
        'qmd://kb-guides/5c201940-c1ac-527d-9fcc-2714ead434fe.md',
        'qmd://kb-curated/cda0ce1e-17f6-4057-be6e-fa83200715f0.md',
        'qmd://kb-guides/b48e0ab0-1f9b-5105-b81c-701544c013ba.md',
      ],
      notes:
        "2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. Both old task guides prescribe pre-Dolt persistence/synchronization. Earlier probe notes retain their historical labels/ranks: 2026-10-23 dense audit: 83567b00 rank 1 and 41f458f7 rank 7 prescribe obsolete bd sync/JSONL/SQLite/beads-sync persistence. Current authority is Dolt/refs/dolt/data, passive JSONL. Both current gold docs also need selective correction under 39z.33. Earlier lexical-only observation: Probe returned 0 hits for this phrasing; 'how do I track tasks' returned 4 noise/other-project hits; keyword probe 'beads task tracking' ranks b48e0ab0 #4 (onboarding still says 'bd sync', which is pre-Dolt). Obsolete: 6dc4a43f (#3 kw) and c680061a describe beads as SQLite + beads-sync git branch (pre-Dolt); ae354749 (#1 kw) bd sync + '10 top-level epics'; 5c201940 prescribes Taskwarrior tracking.",
    },
    {
      id: 'e29',
      kind: 'lexical',
      query: 'how do I mirror a task to GitHub and Plane',
      relevant: [
        'qmd://kb-curated/d5d9927b-b896-5944-a108-9148be37841c.md',
        'qmd://kb-curated/273a0178-1240-5689-8e9e-7d5563ef1b1d.md',
        'qmd://kb-curated/88a6a863-a182-5fc5-8c69-ac221b511188.md',
      ],
      notes:
        "2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. Gold replacement only: the old mirroring procedure remains useful; stale background clauses do not justify an obsolete mirroring label. Earlier probe notes retain their historical labels/ranks: Exact phrasing returned 0 hits; 'mirror a task to GitHub and Plane' ranks d5d9927b #1, b48e0ab0 not in top 10; 'bd-sync mirror GitHub Plane' ranks d5d9927b #1, 273a0178 #2, b48e0ab0 #3. No obsolete doc gives wrong mirror instructions (8a458d74/dba14edb are contradiction records, noise).",
    },
    {
      id: 'e30',
      kind: 'semantic',
      query: 'how should I name a bead',
      relevant: [
        'qmd://kb-curated/3562ff70-7224-588a-b663-6bdac3d83183.md',
        'qmd://kb-guides/6cb17bec-fa71-5796-baee-72dbdd72027f.md',
        'qmd://kb-curated/81ced7c5-e8f0-53cd-b5d5-600251b76adc.md',
      ],
      obsolete: ['qmd://kb-guides/f92788aa-996f-54f6-b649-4ff423d2f742.md'],
      notes:
        "None of the relevant docs in top 10 (top 7 are noise: mission blueprints, ICO idea changelog). Keyword probe 'bead naming plain English' ranks 81ced7c5 #1, 3562ff70 #3, 6cb17bec #4. Obsolete: f92788aa 'Bead Workflow and Epic Execution Conventions' mandates epic:N/type:X coded labels (superseded by 033 addendum); not in top 10 for either phrasing.",
    },
    {
      id: 'e31',
      kind: 'semantic',
      query: 'what is the testing standard for our repos',
      relevant: [
        'qmd://kb-guides/e983d20e-f43c-5e3f-8bae-a1342f881efa.md',
        'qmd://kb-curated/a178f99a-940a-4e35-90bb-acddc5ddf068.md',
      ],
      notes:
        "Probe returned only 1 noise hit (07 Roadmap); relevant not in top 10. Keyword probe 'testing SOP audit-tests implement-tests audit-harness' ranks a178f99a #1, e983d20e #3. a178f99a describes harness v0.1.0 vendored at .audit-harness/ (older install path) but the SOP itself is current.",
    },
    {
      id: 'e32',
      kind: 'semantic',
      query: 'how do I install the brain plugin',
      relevant: [
        'qmd://kb-guides/323b8b4a-ac23-5df9-96ab-f99caf58dbdb.md',
        'qmd://kb-guides/2960262f-d55e-5bef-bb49-e33cd10332ad.md',
        'qmd://kb-curated/b05e4cfc-b97a-52cc-a55f-2bfbdef19676.md',
      ],
      obsolete: [
        'qmd://kb-curated/02e42c1d-7241-57ad-8e21-35cde6c23987.md',
        'qmd://kb-guides/37ed4b2c-0e25-505a-8ff5-366b344c6c90.md',
        'qmd://kb-guides/1167e3f2-f064-594a-9214-6491a01769d4.md',
        'qmd://kb-guides/0b197d62-6651-522e-8c51-be1531b4a9f0.md',
      ],
      notes:
        '2960262f #5; 668bb4ee (rewritten as 323b8b4a in 39z.28) and b05e4cfc not in top 10. Obsolete (none in top 10 for this phrasing): 02e42c1d intent-brain plugin v0.4.0; 37ed4b2c private intent-solutions-marketplace with intent-brain entry; 1167e3f2 private internal catalog with @intent-solutions-io install suffix; 0b197d62 011-RNBK requires GitHub org membership + env vars in shell profile.',
    },
    {
      id: 'e33',
      kind: 'semantic',
      query: 'how do I search the brain',
      relevant: [
        'qmd://kb-guides/95cd747a-564a-5a78-b855-5c00d9d8307c.md',
        'qmd://kb-curated/9b655bbf-dd7f-5d21-b693-64a63a729fb7.md',
        'qmd://kb-curated/86a22878-b5a4-52bc-89cc-4452cd348151.md',
      ],
      obsolete: [
        'qmd://kb-guides/87d86da8-4f48-5bb5-a12a-0e17c7a71cbe.md',
        'qmd://kb-curated/e25bccbd-227a-58b8-b6fa-33449bbbd5be.md',
      ],
      notes:
        "2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. The old commands guide falsely restricts retrieval to keyword-AND rather than natural-language search; the other guide retains a useful search workflow and is not penalized for background index-location errors. Earlier probe notes retain their historical labels/ranks: 7a25e42e #4; e25bccbd and ac51988a not in top 10. 7a25e42e described brain_search as 'qmd search --json'; rewritten as 28604f29 with the fused BM25/FTS5/dense stack in 39z.28. Obsolete: 87d86da8 tells you to use the old teamkb_search MCP tool (now brain_search); not in top 10 here.",
    },
    {
      id: 'e34',
      kind: 'lexical',
      query: 'how does the brain decide what knowledge to keep (compile then govern)',
      relevant: [
        'qmd://kb-guides/b56108ee-cbc9-5794-b8ca-c14686bd199a.md',
        'qmd://kb-curated/66221efa-fad4-5d48-9ba2-6cc224677883.md',
        'qmd://kb-guides/e1adedd1-9886-552f-a39a-aab1e0b30e1e.md',
      ],
      obsolete: ['qmd://kb-curated/081bce4f-1801-539d-a852-add50f441e50.md'],
      notes:
        "2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. The old architecture centrally misstates six Compiler passes as deterministic; the accepted pass delta distinguishes five model-backed passes and deterministic linking, while the existing architecture gold retains the broader governance boundary. Earlier probe notes retain their historical labels/ranks: Full phrasing returned 0 hits (also without the parenthetical). Keyword probe 'compile then govern': 081bce4f #3, e1adedd1 #7, 7203130b not in top 10. Thesis docs use pre-rename repo names but the concept (model proposes, deterministic dedupe/policy/promotion, hash-chained receipts) is current; no obsolete doc misstates it. 9ab72519 (#1 kw) has old repo names (obsolete for e38, not this question).",
    },
    {
      id: 'e35',
      kind: 'semantic',
      query: "how do I verify the brain's audit trail",
      relevant: [
        'qmd://kb-guides/84a42564-fd30-5682-b04e-51a6d814b577.md',
        'qmd://kb-guides/8237fc99-174f-57cb-b27e-5d2b9f80fa46.md',
        'qmd://kb-curated/a8d881cb-288a-50e9-8714-f08548bc961e.md',
      ],
      notes:
        "84a42564 #1; others not in top 10. No doc in scope claims tamper-proof as current (all 'tamper-proof' hits are forbidden-word context). d587fdbc is a contradiction record ('no verification code') - left as noise.",
    },
    {
      id: 'e36',
      kind: 'semantic',
      query: "where does the brain's data live",
      relevant: [
        'qmd://kb-guides/b56108ee-cbc9-5794-b8ca-c14686bd199a.md',
        'qmd://kb-curated/682750ff-6792-52f5-b1ca-d989a52827cc.md',
        'qmd://kb-guides/84a42564-fd30-5682-b04e-51a6d814b577.md',
      ],
      notes:
        '2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. The replacement preserves this question’s useful answer; unrelated stale clauses do not by themselves justify a query-specific obsolete label. Earlier probe notes retain their historical labels/ranks: None of the relevant docs in top 10 (top 5 are SigNoz/Dolt/D88/doc-database noise). No obsolete doc found placing the brain elsewhere.',
    },
    {
      id: 'e37',
      kind: 'semantic',
      query: 'how is the brain backed up',
      relevant: [
        'qmd://kb-guides/e60ee3c7-8cef-51b0-8aa6-d7f0ff358d3e.md',
        'qmd://kb-curated/682750ff-6792-52f5-b1ca-d989a52827cc.md',
        'qmd://kb-guides/b56108ee-cbc9-5794-b8ca-c14686bd199a.md',
      ],
      notes:
        '2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. The replacement preserves this question’s useful answer; unrelated stale clauses do not by themselves justify a query-specific obsolete label. Earlier probe notes retain their historical labels/ranks: None of the relevant docs in top 10; top 10 is noise (brand voice, commit discipline, etc.). Backup runbook 006-AT-RNBK is fully missed. No obsolete brain-backup doc found.',
    },
    {
      id: 'e38',
      kind: 'semantic',
      query: "what are the brain's repositories called",
      relevant: [
        'qmd://kb-curated/43dc743f-fe82-576d-8826-8aa9c651e57e.md',
        'qmd://kb-curated/2b7ef292-a74d-531d-96d5-283476804365.md',
      ],
      obsolete: [
        'qmd://kb-guides/174b389f-def3-57f8-b694-3f343813859b.md',
        'qmd://kb-guides/9ab72519-611c-58d8-a24a-ff4dfe234d95.md',
        'qmd://kb-curated/e65e4505-f169-509c-ab1c-0992707dcee8.md',
        'qmd://kb-guides/28b15174-e241-5b09-9e4a-db4dbad0bada.md',
        'qmd://kb-guides/d9c58178-8268-52e5-919f-a890d084c63d.md',
        'qmd://kb-guides/aee3f27d-c59a-5dc2-87c4-3051f4ef7387.md',
      ],
      notes:
        "2026-10-23 dense audit: 174b389f rank 7 presents qmd-team-intent-kb as the current repository; this label concerns repository identity only, with no formal phase-status judgment. Package/image/Bead aliases deliberately remain valid. Earlier lexical-only observation: Probe returned 0 hits; 'brain repositories' returned 28b15174 #1 (OBSOLETE) and noise, relevant not in top 10. Obsolete: 28b15174 points contributors to intentional-cognition-os/qmd-team-intent-kb; 9ab72519 stack map with old names; e65e4505 repo map lists old engine names + private team marketplace; d9c58178 umbrella as intent-solutions-io/governed-second-brain; aee3f27d 007-SMAP snapshot with 5 repos incl. team marketplace.",
    },
    {
      id: 'e39',
      kind: 'semantic',
      query: 'how do teammates connect to the shared brain',
      relevant: [
        'qmd://kb-guides/2960262f-d55e-5bef-bb49-e33cd10332ad.md',
        'qmd://kb-curated/682750ff-6792-52f5-b1ca-d989a52827cc.md',
        'qmd://kb-decisions/a3c931ad-f613-5d31-b33e-1cbff0e0fc6a.md',
      ],
      obsolete: [
        'qmd://kb-guides/0b197d62-6651-522e-8c51-be1531b4a9f0.md',
        'qmd://kb-guides/37ed4b2c-0e25-505a-8ff5-366b344c6c90.md',
        'qmd://kb-guides/1167e3f2-f064-594a-9214-6491a01769d4.md',
      ],
      notes:
        '2960262f #1 (only hit). Obsolete (not in top 10): 0b197d62 env vars in shell profile + org membership (team.json is current); 37ed4b2c intent-brain private catalog; 1167e3f2 private internal catalog.',
    },
    {
      id: 'e40',
      kind: 'semantic',
      query: 'how do I get a brain access token',
      relevant: [
        'qmd://kb-guides/2960262f-d55e-5bef-bb49-e33cd10332ad.md',
        'qmd://kb-guides/a73cb23b-af79-5c43-8d69-a5b2ebdceb20.md',
        'qmd://kb-curated/6d9d970f-062d-5c60-b08d-049b13022b66.md',
        'qmd://kb-guides/d6649d32-9f90-5249-ad73-32f48dc0212d.md',
      ],
      obsolete: [
        'qmd://kb-guides/0b197d62-6651-522e-8c51-be1531b4a9f0.md',
        'qmd://kb-guides/1167e3f2-f064-594a-9214-6491a01769d4.md',
      ],
      notes:
        "Probe returned 0 hits; 'brain access token' ranks 2960262f #3, 0b197d62 #4 (OBSOLETE), 1167e3f2 #7 (OBSOLETE), 37ed4b2c #8. Obsolete: 0b197d62 export TEAMKB_API_TOKEN in shell profile; 1167e3f2 private catalog install path. 39z.28: the API runbook d92c5eea (tokens plaintext) was rewritten as d6649d32 (scrypt-hashed, how to issue one) and archived, so it moved from obsolete to relevant.",
    },
    {
      id: 'e41',
      kind: 'semantic',
      query: 'what search technology does the brain use',
      relevant: [
        'qmd://kb-decisions/5c98d93b-770f-56c3-ac3e-8a2a39dd75f7.md',
        'qmd://kb-curated/cf735d0b-101f-5600-84f8-75b9f257974b.md',
        'qmd://kb-decisions/79af3f81-3187-545f-b6aa-982a05635680.md',
        'qmd://kb-guides/95cd747a-564a-5a78-b855-5c00d9d8307c.md',
      ],
      obsolete: [
        'qmd://kb-guides/4f61a0c4-f91e-5ae0-8e31-959ec5233ec6.md',
        'qmd://kb-decisions/872fa0b4-d60e-5dde-b3fd-d5cc3e054e28.md',
        'qmd://kb-curated/5d756bb0-fba6-5267-952f-eb9211feae2c.md',
        'qmd://kb-curated/28bceea0-b471-59d3-86bd-e04f8ea2ec87.md',
      ],
      notes:
        "2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. The old retrieval architecture defers serving dense search. The guide already naming all three technologies is not penalized for background index-location errors. Earlier probe notes retain their historical labels/ranks: Probe returned 0 hits (also 'brain retrieval search technology'). Relevant: dense on-by-default decision + RRF qmd BM25/FTS5 + measured dense win, and since 39z.28 the rewritten how-to-use guide 28604f29 (fused stack). Obsolete: 4f61a0c4 'BM25 is the only wired path'; 872fa0b4 044-DECR defers dense and drops EmbeddingGemma (later reversed); 5d756bb0 native backend only 'proposed'. 7a25e42e ('qmd search --json') was superseded and archived 2026-10-16.",
    },
    {
      id: 'e42',
      kind: 'semantic',
      query: 'how do I name and file a document',
      relevant: [
        'qmd://kb-guides/d4e17454-b742-5e5f-b965-e7dd614e6a51.md',
        'qmd://kb-curated/9507c16f-4ed7-508a-abba-97ddbd63309a.md',
      ],
      obsolete: [
        'qmd://kb-guides/3c865bbb-fe3c-5383-8b5a-c3e1e2fd2861.md',
        'qmd://kb-guides/ab762ff1-7b16-52c6-aca3-ee8851666959.md',
        'qmd://kb-guides/9a88a3eb-6bca-50a7-bdef-ef1da24782fc.md',
      ],
      notes:
        "2026-10-23 dense audit: 3c865bbb rank 4 prescribes deployment-docs/four-digit/feature-folder/camelCase grammar, superseded by v4.4. Earlier lexical-only observation: Relevant not in top 10 (LangGraph how-tos dominate). 'document filing naming standard' ranks ab762ff1 v4.2 #1 (OBSOLETE: 6767-series canonical standards) above d4e17454 v4.4 #2. 9a88a3eb also cites 6767-a doc filing (ranks #3 for e26).",
    },
    {
      id: 'e43',
      kind: 'semantic',
      query: 'what project tracker do we use',
      relevant: [
        'qmd://kb-guides/de4bd0ec-3609-58dd-aa1c-8bb32fbbf7e3.md',
        'qmd://kb-guides/4ffce70d-cbee-58bf-ab0e-abd05df5ac69.md',
        'qmd://kb-curated/d5d9927b-b896-5944-a108-9148be37841c.md',
      ],
      notes:
        '2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. Gold replacement only: Plane remains a project tracker; its task-authority overclaim is corrected without penalizing this literal tracker question. Earlier probe notes retain their historical labels/ranks: Relevant not in top 10 (top 3 noise). No doc found naming a different tracker as current (Taskwarrior docs cover personal task tracking, labeled under e28).',
    },
    {
      id: 'e44',
      kind: 'semantic',
      query: 'how do I add something to the brain',
      relevant: [
        'qmd://kb-curated/9b655bbf-dd7f-5d21-b693-64a63a729fb7.md',
        'qmd://kb-curated/5284ce56-c8ce-5960-932d-179b16ba4c61.md',
        'qmd://kb-curated/03e26e71-27ee-5975-81f3-badbb273894b.md',
      ],
      obsolete: [
        'qmd://kb-guides/79b7c1bc-e3f7-53de-bd44-6722cafe51fa.md',
        'qmd://kb-curated/02e42c1d-7241-57ad-8e21-35cde6c23987.md',
        'qmd://kb-curated/3fc61a8d-4f89-5c05-aaa5-925bfb3710b0.md',
      ],
      notes:
        "2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. The old intake convention falsely says intake never deduplicates. The commands guide correctly distinguishes local/team capture and receives no obsolete penalty for this question. Earlier probe notes retain their historical labels/ranks: Relevant not in top 10. 'add a fact to the brain': 79b7c1bc #4 (OBSOLETE: says writes are admin-only and member installs never see write tools; team mode now proxies brain_capture for members), 87d86da8 #2. 02e42c1d: intent-brain /brain-promote skill.",
    },
    {
      id: 'e45',
      kind: 'semantic',
      query: 'what are the rules for branches and worktrees',
      relevant: [
        'qmd://kb-guides/2b16bd66-200c-5afd-8472-ca89bdd146de.md',
        'qmd://kb-decisions/647e8258-fe2e-5fb1-8b12-8eb93f1311c4.md',
      ],
      obsolete: ['qmd://kb-guides/f92788aa-996f-54f6-b649-4ff423d2f742.md'],
      notes:
        "2026-10-23 final correction labels (39z.33/33.3): replace mixed-current gold with accepted, source-reviewed corrections; identical reused citations are deduplicated. The replacement preserves this question’s useful answer; unrelated stale clauses do not by themselves justify a query-specific obsolete label. Earlier probe notes retain their historical labels/ranks: Probe returned 0 hits; 'branch and worktree rules' returned only 3ff6d7c2 (#1). PARTIAL GAP: branch rules are covered, but the owner's 2026-10-09 worktree rule (one task, one branch, one PR; no worktree per subagent; retire only verified-merged) is in no doc. 3ff6d7c2 recommends worktrees for multi-step work, matching ~/CLAUDE.md, so not marked obsolete. Obsolete: f92788aa branch pattern feat/epic{N}-<desc>-bz<story>.",
    },
    {
      id: 'e46',
      kind: 'semantic',
      query: 'how do multiple Claude sessions coordinate on one machine',
      relevant: [
        'qmd://kb-curated/3ff6d7c2-8ae2-5cfb-aa98-f00843d2b8ce.md',
        'qmd://kb-curated/5627a882-42b3-5c70-a2b7-1f03fd77bc9a.md',
        'qmd://kb-guides/166a4550-03b2-5336-8205-b4c0ecccb37f.md',
      ],
      notes:
        "Probe returned 0 hits; 'multiple Claude sessions on one machine' returned only noise. 3ff6d7c2 covers the journal + one-working-tree rule. No obsolete doc.",
    },
    {
      id: 'e48',
      kind: 'semantic',
      query: 'where do I see what work is open across the company',
      relevant: [
        'qmd://kb-guides/d5a1b288-854a-5098-af77-72eae2bba000.md',
        'qmd://kb-guides/9c86a1d5-3d08-5dfb-ba59-38d241e831d6.md',
      ],
      obsolete: ['qmd://kb-guides/cf7e3556-5e7e-5e28-9e17-8773c5ad1698.md'],
      notes:
        "Probe returned 0 hits; 'open work across the company' returned only noise (Team Atlas #1). Obsolete: cf7e3556 points to the retired 01-tracking-index.md as the 'live tracking index'.",
    },
    {
      id: 'e49',
      kind: 'semantic',
      query: 'how does the brain retire knowledge that is no longer true',
      relevant: [
        'qmd://kb-guides/563ddbd3-9eac-5553-9b90-cb2d60d909f2.md',
        'qmd://kb-decisions/f208172c-ed16-5d4f-b0d4-a4abf4181797.md',
        'qmd://kb-curated/fe604b5c-c82a-597a-88b8-161acd727591.md',
      ],
      obsolete: ['qmd://kb-curated/ec76bd88-fc28-50ad-a6bc-20e5fcda47e7.md'],
      notes:
        "Probe returned 0 hits (also 'retire obsolete brain knowledge'). Obsolete: ec76bd88 'Curator Pipeline' says supersession is Jaccard on titles within a category (replaced by SubjectKey slugs, f208172c).",
    },
  ],
};

/** A new-hire question no current doc answers: a documentation hole, not an eval failure. */
export interface EstateGap {
  id: string;
  query: string;
  notes: string;
  /** Obsolete docs seen answering it, for the curator. */
  obsoleteSeen?: string[];
  /**
   * Docs captured later to fill the hole. Reported by rank, not scored: the 45
   * scored queries stay fixed so FAMA stays comparable across runs.
   */
  answeredBy?: string[];
}

export const ESTATE_ONBOARDING_V1_GAPS: EstateGap[] = [
  {
    id: 'e12',
    query: 'how do I merge a pull request',
    notes:
      'No doc mentions ~/bin/safe-merge / merge-guard (merge only through it; never gh pr merge directly). PR-discipline docs (#2 013-OD-STND) only say squash-merge when green. The admin-bypass note 5c22589c was archived 2026-10-16 by owner decision (bead 39z.28): safe-merge only.',
    obsoleteSeen: ['qmd://kb-curated/5c22589c-4c5c-516f-83b4-94ce828790f6.md'],
    answeredBy: ['qmd://kb-curated/cd7be698-96d6-5478-ad33-e6f58c9b69fa.md'], // captured 2026-10-14 (bead 39z.26)
  },
  {
    id: 'e16',
    query: 'how do I open the Netdata monitoring dashboard',
    notes:
      "No doc gives the tailnet URL http://intentsolutions:19999; Ope packet/e945e2cc only say 'tailnet-only'. Probe returned zero results.",
    obsoleteSeen: [
      'qmd://kb-guides/3c6562e3-1083-5e98-a69d-ee2e0f312456.md',
      'qmd://kb-guides/3da6addc-b68e-566a-aaee-797742ac4592.md',
    ],
    answeredBy: ['qmd://kb-guides/c7decb44-1d37-58f5-aa6e-af043f9516b2.md'], // captured 2026-10-14 (bead 39z.26)
  },
  {
    id: 'e18',
    query: 'what video meeting tool do we use',
    notes:
      'Jitsi Meet at meet.intentsolutions.io (owner decision 2026-10-12, intent-os ops/meet) \u2014 not in the corpus yet. Probe returned zero results. Only Google Meet mention is a client-call note (KombiLife), not company tooling.',
    answeredBy: ['qmd://kb-decisions/9db97802-14a4-5ab1-960a-b91c38ef16cf.md'], // captured 2026-10-14 (bead 39z.26)
  },
  {
    id: 'e47',
    query: "what is the company's business mailing address",
    notes:
      'No in-scope doc states the business mailing address (canonical record is intent-os business-plan/company-details.md, not ingested). cbc05dcb gives the legal entity (IntentSolutions.io LLC, Delaware) but no mailing address. Probe hits are Catalyst applicant-address decisions (noise).',
    answeredBy: ['qmd://kb-guides/bae800ff-d00d-5752-b99e-9fea8353f42d.md'], // captured 2026-10-14 (bead 39z.26)
  },
  {
    id: 'e50',
    query: 'where are the LLM provider API keys stored',
    notes:
      'No doc names the intent-eval-lab .env.sops store for Anthropic/OpenAI/Groq/NVIDIA/DeepSeek keys. 6243141f (SOPS+age standard) gives the general rule only. Probe top 10 is generic LLM/provider noise.',
    answeredBy: ['qmd://kb-guides/cf7bfdac-c3f5-548f-bffb-79b710c1e999.md'], // captured 2026-10-14 (bead 39z.26)
  },
];
