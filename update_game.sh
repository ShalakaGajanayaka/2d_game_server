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

echo "🚀 Deploying to Nginx web directory with Cache-Busting..."
mkdir -p /var/www/skyrush/game_web
rm -rf /var/www/skyrush/game_web/*
cp -rf build/web/* /var/www/skyrush/game_web/

BUILD_TS=$(date +%s)
sed -i "s/main\.dart\.js/main.dart.js?v=$BUILD_TS/g" /var/www/skyrush/game_web/flutter_bootstrap.js
sed -i "s/flutter_bootstrap\.js/flutter_bootstrap.js?v=$BUILD_TS/g" /var/www/skyrush/game_web/index.html

systemctl restart nginx

echo "=========================================================="
echo "🎉 GAME UPDATE COMPLETED! LIVE ON https://skyrush.cc 🎉"
echo "=========================================================="
