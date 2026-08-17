# AI Agent Instructions

Before doing any Homey app development work in this repository, read
`../.agents/AGENTS.md` and the skills it points to — in particular
`../.agents/skills/homey-app-development/SKILL.md`.

That `.agents` folder lives one level up (`~/HomeyDev/.agents`) and is shared across all
Homey app projects under `~/HomeyDev/`. It documents mandatory rules and hard-won,
empirically-confirmed findings for this codebase family, including:
- A hard rule against unverified assumptions about SDK/API/CLI behavior — verify against
  source, official docs, or a live test before asserting anything as fact.
- Camera images (`setCameraImage`) are **not** capabilities — separate mechanism entirely,
  with its own order/removal rules that differ sharply from regular capabilities.
- Homey Insights API gotchas (capability-to-log mapping, timestamp alignment, resolution
  quirks).
- V8 sandbox memory constraints and remote-debugging/rate-limit behavior.
- Cross-driver/cross-app pattern consistency expectations.

Do not skip this — it exists specifically because these findings were each learned the hard
way, more than once, before being written down.
