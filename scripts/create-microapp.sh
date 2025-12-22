#!/usr/bin/env bash
set -euo pipefail

# Simple helper to create a new micro-app repo from the ClosureAI template.
# Requirements:
#   - GitHub CLI: gh (authenticated)
#   - This repo (template) already marked as a "Template repository" on GitHub.
#
# Usage:
#   ./scripts/create-microapp.sh \\
#     --app-name "Sarah's Clarity Studio" \\
#     --app-id "sarah-clarity" \\
#     --base-url "https://app.sarahclarity.com" \\
#     --coach-name "Sarah Example" \\
#     --support-email "support@sarahclarity.com" \\
#     --github-user "KeithPelchat"

APP_NAME=""
APP_ID=""
APP_BASE_URL=""
COACH_NAME=""
SUPPORT_EMAIL=""
GITHUB_USER=""
TEMPLATE_REPO="closureai"  # repo name on GitHub

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-name)
      APP_NAME="$2"; shift 2 ;;
    --app-id)
      APP_ID="$2"; shift 2 ;;
    --base-url)
      APP_BASE_URL="$2"; shift 2 ;;
    --coach-name)
      COACH_NAME="$2"; shift 2 ;;
    --support-email)
      SUPPORT_EMAIL="$2"; shift 2 ;;
    --github-user)
      GITHUB_USER="$2"; shift 2 ;;
    *)
      echo "Unknown argument: $1"
      exit 1 ;;
  esac
done

if [[ -z "$APP_NAME" || -z "$APP_ID" || -z "$APP_BASE_URL" || -z "$COACH_NAME" || -z "$SUPPORT_EMAIL" || -z "$GITHUB_USER" ]]; then
  echo "Missing required arguments."
  echo "Usage:"
  echo "  ./scripts/create-microapp.sh \\"
  echo "    --app-name \"Coach App Name\" \\"
  echo "    --app-id \"app-id\" \\"
  echo "    --base-url \"https://app.domain.com\" \\"
  echo "    --coach-name \"Coach Name\" \\"
  echo "    --support-email \"support@example.com\" \\"
  echo "    --github-user \"YourGitHubUser\""
  exit 1
fi

NEW_REPO_NAME="${APP_ID}"

echo "==> Creating new repo from template: ${GITHUB_USER}/${TEMPLATE_REPO} -> ${GITHUB_USER}/${NEW_REPO_NAME}"

# Create a new repo on GitHub from the template
gh repo create "${GITHUB_USER}/${NEW_REPO_NAME}" \
  --template "${GITHUB_USER}/${TEMPLATE_REPO}" \
  --private \
  --confirm

echo "==> Waiting for GitHub to finish template population..."

# Wait until the repo has at least one commit (template copied)
REPO_URL="https://api.github.com/repos/${GITHUB_USER}/${NEW_REPO_NAME}/commits"

for i in {1..10}; do
  if curl -s "${REPO_URL}" | grep -q '"sha"'; then
    echo "==> Template content detected."
    break
  fi
  echo "   Template not ready yet... retrying in 2 seconds"
  sleep 2
done

echo "==> Cloning ${NEW_REPO_NAME}..."
git clone "git@github.com:${GITHUB_USER}/${NEW_REPO_NAME}.git"

cd "${NEW_REPO_NAME}"

# Create .env from template
if [[ ! -f ".env.template" ]]; then
  echo "ERROR: .env.template not found in new repo."
  exit 1
fi

cp .env.template .env

# Replace placeholders in .env
# Use .bak for portability across macOS/Linux
sed -i.bak \
  -e "s|__APP_NAME__|${APP_NAME}|g" \
  -e "s|__APP_ID__|${APP_ID}|g" \
  -e "s|__APP_BASE_URL__|${APP_BASE_URL}|g" \
  -e "s|__COACH_NAME__|${COACH_NAME}|g" \
  -e "s|__SUPPORT_EMAIL__|${SUPPORT_EMAIL}|g" \
  .env

rm .env.bak

echo ""
echo "==> Repo created: ${GITHUB_USER}/${NEW_REPO_NAME}"
echo "==> Next steps:"
echo "  1) cd ${NEW_REPO_NAME}"
echo "  2) Edit .env and fill in:"
echo "     - OPENAI_API_KEY"
echo "     - STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET"
echo "     - JWT_SECRET (long random string)"
echo "  3) Commit and push if needed:"
echo "       git add .env"
echo "       git commit -m \"Configure env for ${APP_NAME}\""
echo "       git push"
echo "  4) Deploy using your usual process."
