# Search Does Search — notes for agents

A GNOME Shell extension (TypeScript in `src/`, compiled to `dist/`) plus a plain
GJS WebKit renderer process (`panel/sds-renderer.js`). How it fits together is in
`docs/ARCHITECTURE.md`; how to build and test it is in `docs/DEVELOPMENT.md`; the
compositor-thread rules every change must respect are in `docs/GJS-PITFALLS.md`.

## Coordinate through agent-locks

Several agents work on this repository at once, usually in separate
`git worktree`s. They coordinate with [agent-locks](https://github.com/luohoa97/agent-locks)
(configured in `.mcp.json`), which keeps its lock files under the shared `.git`
directory, so every worktree sees them and none of them is ever committed.

1. Before touching files, `lock_query` to see what is in flight and
   `lock_check_conflict` with the globs you are about to edit.
2. If something overlaps, pick a narrower scope or work elsewhere; do not edit
   files another active lock claims.
3. `lock_create` with a title, the globs, and a task checklist.
4. `lock_update` each task the moment it is done, not in a batch at the end.
5. `lock_finish` with a one-line summary when the work is committed.

Uncommitted changes in a worktree you did not create belong to someone else:
work in your own worktree (`git worktree add ../searchDOESsearch-<topic> -b <topic> origin/main`)
rather than building on top of them.

## Testing

`make check` runs the headless tests. Anything that changes what the Shell shows
must also be tried in a nested session: `make nested` (a window on your desktop)
or `./scripts/nested-test.sh --headless --gdr` (a virtual monitor that the gdr
tools can screenshot and drive). Never kill `gnome-shell` by name — that is the
host desktop.
