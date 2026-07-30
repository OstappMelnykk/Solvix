# Solvix

## Branching strategy

This project follows **Git Flow**:

- `main` — always stable, release-ready code. Never committed to directly.
- `dev` — integration branch for all features and regular fixes.
- `feature/*` — new functionality, branched from `dev`, merged back into `dev`.
- `fix/*` — regular (non-critical) bug fixes, branched from `dev`, merged back into `dev`.
- `release/<version>` — release stabilization, branched from `dev`, merged into both `main` and `dev`, then deleted.
- `hotfix/*` — critical production fixes, branched from `main`, merged into both `main` and `dev`.

```mermaid
%%{init: { 'theme': 'base', 'gitGraph': {'showCommitLabel': true, 'mainBranchOrder': 1} }}%%
gitGraph
    commit id: "init"
    branch dev order: 2
    checkout dev
    commit id: "dev-setup"
    commit id: "dev-work-1"
    branch feature/x order: 3
    checkout feature/x
    commit id: "feat-work-1"
    commit id: "feat-work-2"
    checkout dev
    merge feature/x id: "merge-feature-x"
    commit id: "dev-work-2"
    commit id: "dev-work-3"
    branch release/1.0 order: 4
    checkout release/1.0
    commit id: "rel-fix-1"
    commit id: "rel-fix-2"
    checkout main
    merge release/1.0 tag: "v1.0" id: "release-1.0"
    checkout dev
    merge release/1.0 id: "sync-release-1.0"
    commit id: "dev-work-4"
    commit id: "dev-work-5"
    checkout main
    branch hotfix/x order: 0
    commit id: "hotfix-fix"
    checkout main
    merge hotfix/x tag: "v1.0.1" id: "release-1.0.1"
    checkout dev
    merge hotfix/x id: "sync-hotfix-x"
    commit id: "dev-work-6"
```

Full details: [`docs/BRANCHING.md`](docs/BRANCHING.md).