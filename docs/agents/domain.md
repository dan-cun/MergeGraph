# Domain Docs

Engineering skills should consume this repo's domain documentation using the single-context layout.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, when it exists.
- **`docs/adr/`**, reading the ADRs that touch the area being changed, when the directory exists.

If these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. Create them lazily when domain terms or architectural decisions actually need to be recorded.

## File structure

```text
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-决策主题.md
│   └── 0002-决策主题.md
└── src/
```

## Use the glossary vocabulary

When output names a domain concept, use the term defined in `GLOSSARY.md`. If a needed concept is not defined, record the terminology gap for later domain modeling instead of silently inventing competing names.

## Flag ADR conflicts

If an output contradicts an existing ADR, surface the conflict explicitly and identify the ADR before proposing a change.
