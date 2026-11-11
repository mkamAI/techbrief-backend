#!/bin/bash
# TechBrief Backend — one-click Vercel deploy (non-interactive)
set -e

cd "$(dirname "$0")"

echo ""
echo "🚀 TechBrief Backend — Vercel Deploy"
echo "────────────────────────────────────"
echo ""

# Use npx so no global install needed
VERCEL="npx vercel@latest"

echo "🔑 Checking Vercel auth (browser may open)..."
$VERCEL login

echo ""
echo "⚙️  Deploying to production..."
$VERCEL deploy --prod --yes --name techbrief-backend 2>&1

DEPLOY_URL=$($VERCEL --prod --yes --name techbrief-backend 2>/dev/null | grep "https://" | tail -1 || true)

echo ""
echo "──────────────────────────────────────────────────"
echo "✅ Deployed!"
echo ""
echo "Now add your Anthropic API key:"
echo ""
$VERCEL env add ANTHROPIC_API_KEY production
echo ""
echo "Final deploy to pick up the key:"
$VERCEL deploy --prod --yes --name techbrief-backend
echo ""
echo "✅ All done! Your backend URL is printed above."
echo "──────────────────────────────────────────────────"
read -p "Press Enter to close..."
