# Packs directory resolution

Every `wikigr` command reads and writes knowledge packs under a single **packs
directory** (the "install root"). Each pack is a subdirectory of it — e.g. the CVE
pack installs to `<packs dir>/cve/` with a `manifest.json` + `pack.db` inside.

This document is the single source of truth for **where that directory is** and
**how to override it**. The same resolution is shared by the `wikigr` CLI and the
`@kgpacks/mcp` server so a pack installed by one is found by the other.

## The default: an XDG data directory

For an installed CLI, the default packs directory follows the
[XDG Base Directory](https://specifications.freedesktop.org/basedir-spec/latest/)
convention so packs live in a stable, per-user, location-independent place — **not**
under the current working directory:

| Platform      | Default packs directory                                            |
| ------------- | ------------------------------------------------------------------ |
| Linux / macOS | `$XDG_DATA_HOME/kgpacks`, falling back to `~/.local/share/kgpacks` |
| Windows       | `%LOCALAPPDATA%\kgpacks` (falls back to `~/.local/share/kgpacks`)  |

> **Why this changed.** Earlier builds defaulted to a **cwd-relative**
> `./data/packs`, so `wikigr query cve …` only found the pack when you `cd`'d back
> to the directory you installed from. The XDG default makes the installed CLI
> behave like a normal user tool: install once, query from anywhere.
>
> The **repo/dev** flows are unaffected — running from a checkout you still pass
> `--packs-dir data/packs` (as the clone-based instructions do), which wins over
> the default.

`wikigr status` always prints the **resolved** packs directory so you can see
exactly where a command will read/write:

```bash
wikigr status
# packs dir: /home/alice/.local/share/kgpacks
# installed: cve@2025.6.0 (343,007 records)
```

## Precedence

The directory is resolved from four sources, highest priority first:

| Priority | Source                          | Example                                   |
| -------- | ------------------------------- | ----------------------------------------- |
| 1        | `--packs-dir <dir>` flag        | `wikigr query cve … --packs-dir /data/kg` |
| 2        | Programmatic injection          | tests / embedders passing an install root |
| 3        | `KGPACKS_PACKS_DIR` environment | `export KGPACKS_PACKS_DIR=/data/kg`       |
| 4        | XDG default (above)             | `~/.local/share/kgpacks`                  |

An empty or whitespace-only value at any level is treated as **unset** and falls
through to the next source. The flag and the environment variable are honored by
**every** command (`pack pull`, `pack install`, `query`, `pack eval`, `status`,
`pack info`, `pack remove`, `create`, …), so a single override applies end to end:

```bash
export KGPACKS_PACKS_DIR=/srv/kgpacks
wikigr pack pull cve       # installs /srv/kgpacks/cve
wikigr query cve "…" -k 5  # same env → finds it
wikigr status              # packs dir: /srv/kgpacks
```

Mixing sources works as expected — the flag beats the environment for one command
without disturbing the rest:

```bash
export KGPACKS_PACKS_DIR=/srv/kgpacks
wikigr query cve "…" --packs-dir /mnt/readonly/kgpacks   # this call only
```

## Migrating from a `./data/packs` install

Packs are self-contained directories, so moving them is a plain filesystem move
(nothing rewrites paths inside `pack.db`):

```bash
mkdir -p ~/.local/share/kgpacks
mv ./data/packs/* ~/.local/share/kgpacks/     # or: cve/ specifically
wikigr status                                  # confirms the new default location
```

If you prefer to keep packs where they are, point the default at them once with
`KGPACKS_PACKS_DIR` (e.g. in your shell profile).

## The MCP server

`@kgpacks/mcp` resolves the **same** default and honors the **same**
`KGPACKS_PACKS_DIR` override, so an MCP host (VS Code, Claude Desktop) finds
CLI-installed packs without extra configuration:

```bash
# Uses the XDG default — finds packs installed by `wikigr pack pull`
npx -y kgpacks-mcp

# …or pin an explicit root (highest precedence)
KGPACKS_PACKS_DIR=/srv/kgpacks npx -y kgpacks-mcp
```

See [docs/packages/mcp.md](packages/mcp.md#configuration) for the full MCP
configuration reference.

## Related docs

- [docs/using-the-cve-pack.md](using-the-cve-pack.md) — install & query the CVE pack.
- [docs/packages/mcp.md](packages/mcp.md) — the MCP server's packs-dir resolution.
- [docs/packages/packs.md](packages/packs.md) — the pack on-disk layout.
