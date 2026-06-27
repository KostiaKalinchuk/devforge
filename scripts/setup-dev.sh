#!/usr/bin/env bash
# One-time setup for DevForge contributors.
# Run after cloning and `npm install`.

set -e

echo "Installing Claude Code plugins for DevForge development..."

claude plugin install superpowers@claude-plugins-official
claude plugin install code-review@claude-plugins-official
claude plugin install playwright@claude-plugins-official
claude plugin install context7@claude-plugins-official
claude plugin install security-guidance@claude-plugins-official

echo ""
echo "Done. Open this repo in Claude Code and you're ready."
