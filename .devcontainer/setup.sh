#!/usr/bin/env bash
# .devcontainer/setup.sh — runs once inside the container after creation.
# Safe to re-run; all steps are idempotent.
set -euo pipefail

# ── System packages ───────────────────────────────────────────────────────────
echo "→ Installing system packages (vim, shellcheck)…"
sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends vim shellcheck

# ── Security tooling ──────────────────────────────────────────────────────────
# Trivy is used by the security-scan CI job (ci.yml); installing it locally lets
# contributors reproduce the image scan before pushing. Skip if already present.
if ! command -v trivy >/dev/null 2>&1; then
    echo "→ Installing Trivy…"
    curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
        | sudo sh -s -- -b /usr/local/bin
else
    echo "→ Trivy already installed — skipping."
fi

# ── Dev tools ─────────────────────────────────────────────────────────────────
echo "→ Installing dev tools (npm install)…"
# node_modules and package-lock.json may be owned by root if a prior container
# run or image layer executed npm install as root.  Fix ownership first so that
# the npm install below (running as the 'node' user) can write to them.
sudo chown -R node:node /workspace/node_modules /workspace/package-lock.json /workspace/coverage 2>/dev/null || true
cd /workspace && npm install

# ── Git config ───────────────────────────────────────────────────────────────
# .gitconfig is staged at /tmp/host-gitconfig (bind-mounted read-only).
# Copy it so git can write to ~/.gitconfig freely (bind-mounted files can't
# be atomically replaced, which causes "Device or resource busy" errors).
echo "→ Configuring git…"
if [ -s /tmp/host-gitconfig ]; then
    cp /tmp/host-gitconfig ~/.gitconfig
    echo "  ~/.gitconfig installed."
else
    echo "  No host .gitconfig found — skipping."
fi

# ── SSH keys ──────────────────────────────────────────────────────────────────
# .ssh is staged at /tmp/host-ssh (bind-mounted read-only from the host).
# We copy it to ~/.ssh with the permissions SSH requires (700/600).
# Contributors without an .ssh directory simply skip this step.
echo "→ Configuring SSH…"
if [ -d /tmp/host-ssh ] && [ -n "$(ls -A /tmp/host-ssh 2>/dev/null)" ]; then
    mkdir -p ~/.ssh
    cp -rp /tmp/host-ssh/. ~/.ssh/
    chmod 700 ~/.ssh
    find ~/.ssh -type f -exec chmod 600 {} \;
    echo "  SSH keys installed."

    # The host's OpenSSH client may be newer than the container's (Debian 13
    # ships OpenSSH 10.0), so the host config can use options this client
    # rejects (e.g. WarnWeakCrypto), which breaks every ssh/git operation.
    # Probe the config and comment out unsupported option lines one by one.
    if [ -f ~/.ssh/config ]; then
        for _ in 1 2 3 4 5; do
            bad_opt=$(ssh -G -F ~/.ssh/config github.com 2>&1 >/dev/null \
                | sed -n 's/.*Bad configuration option: *//p' | head -1)
            [ -z "$bad_opt" ] && break
            echo "  Disabling unsupported ssh option: $bad_opt"
            sed -i -E "s/^([[:space:]]*)(${bad_opt})([[:space:]]|$)/\1# \2\3/I" ~/.ssh/config
        done
    fi
else
    echo "  No SSH keys found on host — skipping."
fi

# ── GitHub CLI credentials ────────────────────────────────────────────────────
# ~/.config/gh is bind-mounted directly from the host (see devcontainer.json),
# so the host's `gh` login is reused as-is — no copy step and no
# re-authentication. A bind mount keeps the host uid, which usually differs
# from the container user, so grant the container user ownership of the mounted
# path (otherwise a 0600 hosts.yml is unreadable and gh fails).
echo "→ Configuring GitHub CLI…"
if [ -e ~/.config/gh ]; then
    sudo chown -R "$(id -u):$(id -g)" ~/.config/gh
    echo "  Host gh config mounted."
else
    echo "  No host gh config found — skipping."
fi

# ── .profile (SSH signing env vars etc.) ──────────────────────────────────────
# The host .profile is mounted to ~/.profile-host.
# VS Code terminals start as non-login interactive shells, so ~/.profile is
# not sourced automatically.  We add a one-time source line to both rc files.
echo "→ Wiring ~/.profile-host into shell init files…"
if [ -s ~/.profile-host ]; then
    for rc in ~/.bashrc ~/.zshrc; do
        if [ -f "$rc" ] && ! grep -q 'profile-host' "$rc" 2>/dev/null; then
            echo '' >> "$rc"
            echo '# Sourced by devcontainer setup — host .profile (SSH signing, etc.)' >> "$rc"
            echo 'source ~/.profile-host 2>/dev/null || true' >> "$rc"
        fi
    done
    echo "  Done."
else
    echo "  ~/.profile-host is empty — skipping."
fi

echo ""
echo "✅ Container setup complete."
echo "   Workspace  : /workspace"
echo "   Node       : $(node --version)"
echo "   npm        : $(npm --version)"
echo "   vitest     : $(npx vitest --version 2>&1 | head -1)"
echo "   gh         : $(gh --version 2>&1 | head -1)"
echo "   gh auth    : $(gh auth status 2>&1 | head -1 || true)"
echo "   docker     : $(docker --version 2>/dev/null || echo 'not available')"
echo "   compose    : $(docker compose version 2>/dev/null | head -1 || echo 'not available')"
echo "   shellcheck : $(shellcheck --version 2>/dev/null | sed -n 's/^version: //p' || echo 'not installed')"
echo "   trivy      : $(trivy --version 2>/dev/null | head -1 || echo 'not installed')"
