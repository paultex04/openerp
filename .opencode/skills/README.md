# Project skills

Skills vendored into this repository. OpenCode discovers `.opencode/skills/`
automatically (each skill's ID is its directory name), so no config is needed.
Project skills take precedence over same-ID skills installed globally.

| Skill | Source | Purpose |
| ----- | ------ | ------- |
| `caveman` | `juliusbrussee/caveman` | Terse caveman voice: answer first, no fluff, every technical fact kept. |
| `find-skills` | `vercel-labs/skills` | Discover and install further skills from the open skills ecosystem. |
| `frontend-design` | `anthropics/skills` | Distinctive, intentional visual design for new or reshaped UI. |
| `grill-me` | `mattpocock/skills` | Thin trigger that loads `grilling`. |
| `grilling` | `mattpocock/skills` | Relentless interview to stress-test a plan or design. Required by `grill-me`. |
| `handoff` | `mattpocock/skills` | Produce a handoff summary of work in progress. |
| `shadcn` | `shadcn/ui` | Manage shadcn/ui components, registries, presets and design systems. |
| `vercel-react-best-practices` | `vercel-labs/agent-skills` | React and Next.js performance guidelines (40+ rules across 8 categories). |
| `web-design-guidelines` | `vercel-labs/agent-skills` | Audit UI code against the Web Interface Guidelines. |

## Notes

- `grill-me` only exists to load `grilling`, so both are vendored.
- Files are byte-for-byte copies of the upstream skill directories (verified
  against each repository's `main` tree). Upstream skill directories are not
  always named after the installed ID, for example `vercel-react-best-practices`
  comes from `vercel-labs/agent-skills` at `skills/react-best-practices`.
- To refresh a skill, reinstall it with the skills CLI
  (`npx skills add <owner/repo> -s <skill> -y --copy`) and copy the result in
  from `.agents/skills/<skill>`.
