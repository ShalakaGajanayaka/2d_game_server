#!/bin/bash
set -e

echo "=========================================================="
echo "⚡ FAST UPDATE: SKYRUSH 2D WEB GAME"
echo "=========================================================="

export PATH="$PATH:/opt/flutter/bin"
git config --global --add safe.directory /opt/flutter || true

cd /var/www/skyrush/game_app
echo "📥 Pulling latest game changes from GitHub..."
git pull origin main

echo "🔨 Building Flutter Web..."
echo "SERVER_API_URL=https://engine.skyrush.cc" > .env
/opt/flutter/bin/flutter config --no-analytics
/opt/flutter/bin/flutter build web --release --no-wasm-dry-run

echo "🚀 Deploying to Nginx web directory..."
mkdir -p /var/www/skyrush/game_web
rm -rf /var/www/skyrush/game_web/*
cp -rf build/web/* /var/www/skyrush/game_web/

systemctl restart nginx

echo "=========================================================="
echo "🎉 GAME UPDATE COMPLETED! LIVE ON https://skyrush.cc 🎉"
echo "=========================================================="
