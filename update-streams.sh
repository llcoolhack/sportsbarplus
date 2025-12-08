#!/bin/bash
set -euo pipefail

# 👉 CHANGE this to your actual repo path
REPO_DIR="/Users/lochie.hackett/Desktop/token-fetcher" 

cd "$REPO_DIR"

# ---- CREDENTIALS ----
# Easiest (but less secure) is to hard-code them here.
# Better is to export them in your shell profile and just rely on env vars.
export ZUZZ_USERNAME="YOUR_EMAIL_HERE"
export ZUZZ_PASSWORD="YOUR_PASSWORD_HERE"

# ---- Node setup (assumes you already ran `npm install` at least once) ----
# If node_modules might not exist, uncomment this:
# if [ ! -d node_modules ]; then
#   npm install
# fi

echo "=== $(date) Starting stream update ==="

# Run the fetcher
node fetch-nba-today.mjs

# Only commit if index.html or JSON actually changed
if git diff --quiet index.html sportsplus_serv_urls.json; then
  echo "No changes to commit."
  exit 0
fi

echo "Changes detected, committing..."

git add index.html sportsplus_serv_urls.json
git commit -m "Auto update stream URLs"
git push origin main   # change 'main' if your default branch is different

echo "=== $(date) Update complete ==="
