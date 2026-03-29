# devcontainerv

A fork of the [Dev Container CLI](https://github.com/devcontainers/cli) with workspace volume management.

This fork adds the ability to clone repositories into Docker volumes, manage named volumes and containers with date-based sequencing, rebuild from cloned volumes, and clean up old resources.

## Install

```bash
npm install -g devcontainerv
```

Or via Homebrew (macOS):

```bash
brew tap martin-r-dev/devcontainerv
brew install devcontainerv
```

## What's new

### Workspace volume workflow

Instead of bind-mounting a local directory, `devcontainerv` can clone a Git repository into a Docker volume and use that as the workspace. This is useful for remote/CI workflows where you don't want (or need) the source on the host filesystem.

Volumes and containers follow a naming convention: `<prefix>-vol-YYMMDD-NN` / `<prefix>-ctr-YYMMDD-NN`, where `NN` auto-increments per day.

### Reference syntax

Several options accept a volume or container reference. These can be:

| Format | Meaning |
|---|---|
| `my-exact-name` | Literal name |
| `foo@latest` | Most recent `foo-vol-*` or `foo-ctr-*` |
| `foo@260325-01` | Specific: `foo-vol-260325-01` |
| `foo@-1` | Keep 1 most recent (used by `cleanup-old`) |
| `foo@-0` | Keep none — remove all matching |

## New CLI options

### `devcontainerv up` and `devcontainerv build`

| Option | Description |
|---|---|
| `--repository <url>` | Repository URL to clone into a Docker volume (HTTPS or SSH). SSH URLs use agent forwarding. |
| `--repository-ref <ref>` | Branch, tag, or commit to checkout. |
| `--gen-vol-prefix <prefix>` | Auto-generate volume name: `<prefix>-vol-YYMMDD-NN`. |
| `--vol-name <name>` | Use an explicit volume name (mutually exclusive with `--gen-vol-prefix`). |
| `--from-vol <ref>` | Clone an existing volume as the build base. Accepts reference syntax. |

### `devcontainerv up` only

| Option | Description |
|---|---|
| `--with-vol <ref>` | Use an existing volume as-is, without cloning. Accepts reference syntax. |
| `--gen-ctr-prefix <prefix>` | Auto-generate container name: `<prefix>-ctr-YYMMDD-NN`. |
| `--ctr-name <name>` | Use an explicit container name (mutually exclusive with `--gen-ctr-prefix`). |

### `devcontainerv cleanup-old`

| Option | Description |
|---|---|
| `--vol-prefix <prefix@-N>` | Remove old volumes, keeping the most recent N. |
| `--ctr-prefix <prefix@-N>` | Remove old containers, keeping the most recent N. |
| `--dry-run` | Show what would be removed without actually removing. |

## Examples

### Fresh clone and build + up

```bash
devcontainerv up \
  --repository https://github.com/owner/repo.git \
  --gen-vol-prefix myproj \
  --gen-ctr-prefix myproj
```

Creates `myproj-vol-260325-01`, clones the repo into it, builds the image, and starts `myproj-ctr-260325-01`.

Output:

```json
{
  "outcome": "success",
  "remoteWorkspaceFolder": "/workspaces/repo",
  "volumeName": "myproj-vol-260325-01",
  "containerName": "myproj-ctr-260325-01"
}
```

### Clone a specific branch

```bash
devcontainerv up \
  --repository git@github.com:owner/repo.git \
  --repository-ref feature/my-branch \
  --gen-vol-prefix myproj \
  --gen-ctr-prefix myproj
```

SSH URLs automatically forward the host's SSH agent for authentication.

### Rebuild from an existing volume (no re-clone)

Make changes inside the container, then rebuild from the current volume:

```bash
devcontainerv up \
  --from-vol myproj@latest \
  --gen-vol-prefix myproj \
  --gen-ctr-prefix myproj
```

Clones `myproj-vol-260325-01` → `myproj-vol-260325-02` and starts `myproj-ctr-260325-02`. The new volume has all your local changes without needing to push/pull from the remote.

### Re-up with an existing volume (no rebuild)

```bash
devcontainerv up \
  --with-vol myproj@latest \
  --gen-ctr-prefix myproj
```

Starts a new container using the existing volume as-is.

### Build only (no container)

```bash
devcontainerv build \
  --repository https://github.com/owner/repo.git \
  --gen-vol-prefix myproj
```

### Clean up old resources

```bash
# Preview what would be removed
devcontainerv cleanup-old \
  --vol-prefix "myproj@-1" \
  --ctr-prefix "myproj@-1" \
  --dry-run

# Remove all but the latest 1
devcontainerv cleanup-old \
  --vol-prefix "myproj@-1" \
  --ctr-prefix "myproj@-1"

# Remove everything
devcontainerv cleanup-old \
  --vol-prefix "myproj@-0" \
  --ctr-prefix "myproj@-0"
```

## Upstream

All standard `devcontainer` commands and options continue to work unchanged. See the [upstream README](https://github.com/devcontainers/cli#readme) for full documentation.
