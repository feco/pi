#!/bin/sh
set -e

# Start Docker daemon in background
dockerd > /var/log/dockerd.log 2>&1 &

# Wait until Docker is ready
echo "Waiting for Docker daemon..."
until docker info >/dev/null 2>&1; do
  sleep 0.5
done
echo "Docker daemon ready."

# Configure a repository-scoped HTTPS credential from the single mounted secret.
if [ -f /run/secrets/git-token ] && [ -n "$GIT_AUTH_HOST" ]; then
  cat > /tmp/git-credential-helper.sh << 'CREDEOF'
#!/bin/sh
[ "${1:-}" = "get" ] || exit 0
host=""
path=""
while IFS='=' read -r key value; do
  case "$key" in
    host) host="$value" ;;
    path) path="$value" ;;
  esac
done

normalize_path() {
  printf '%s' "$1" | sed 's|^/||; s|\.git$||'
}

[ "$host" = "$GIT_AUTH_HOST" ] || exit 0
[ -z "$GIT_AUTH_PATH" ] || [ "$(normalize_path "$path")" = "$(normalize_path "$GIT_AUTH_PATH")" ] || exit 0

printf 'username=%s\n' "$GIT_AUTH_USERNAME"
printf 'password=%s\n' "$(cat /run/secrets/git-token)"
CREDEOF
  chmod 700 /tmp/git-credential-helper.sh

  # Azure SSH URLs must use HTTPS for PAT authentication.
  if [ "$GIT_AUTH_HOST" = "dev.azure.com" ]; then
    azure_url=$(git remote get-url origin 2>/dev/null || true)
    case "$azure_url" in
      git@ssh.dev.azure.com:*)
        https_url=$(echo "$azure_url" | sed 's|git@ssh.dev.azure.com:v3/|https://dev.azure.com/|; s|/\([^/]*\)$|/_git/\1|')
        git remote set-url origin "$https_url"
        echo "Remote rewritten to HTTPS: $https_url"
        ;;
    esac
  fi

  # GitHub SSH URLs must also use HTTPS for token authentication.
  if [ "$GIT_AUTH_HOST" = "github.com" ]; then
    github_url=$(git remote get-url origin 2>/dev/null || true)
    case "$github_url" in
      git@github.com:*|ssh://git@github.com/*)
        https_url="https://github.com/$GIT_AUTH_PATH.git"
        git remote set-url origin "$https_url"
        echo "Remote rewritten to HTTPS: $https_url"
        ;;
    esac
  fi
  echo "Git credentials configured for $GIT_AUTH_HOST/$GIT_AUTH_PATH."
fi

# Configure git user identity — personal by default, work for Elia repos
cat > "$HOME/.gitconfig" << GITEOF
[user]
	name = Goulven
	email = feco.veil@gmail.com
[includeIf "gitdir:**/Elia/**"]
	path = /root/.pi/git-user-work
GITEOF
echo "Git identity: personal (default), work for Elia repos."

# Keep credentials scoped to the full repository path, not just the host.
if [ -f /tmp/git-credential-helper.sh ]; then
  git config --global credential.useHttpPath true
  git config --global credential.helper /tmp/git-credential-helper.sh
fi

exec pi "$@"
