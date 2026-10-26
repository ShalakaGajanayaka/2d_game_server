#!/bin/bash
# ==============================================================================
# SkyRush 2D Game Server - Automated Zero-Downtime Hot Update Script
# Usage: 
#   bash update_server.sh          (Updates & Hot-Reloads Backend Engine)
#   bash update_server.sh --all    (Updates Backend + Dashboard + Frontend)
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="/var/www/skyrush/server"
DASHBOARD_DIR="/var/www/skyrush/dashboard"
GAME_DIR="/var/www/skyrush/game_app"
GAME_WEB_DIR="/var/www/skyrush/game_web"

# Fallback to local script dir if not in standard production path
if [ ! -d "$SERVER_DIR" ]; then
    SERVER_DIR="$SCRIPT_DIR"
fi

echo "=========================================================="
echo "🚀 SkyRush Production Zero-Downtime Hot Update"
echo "⏰ Time: $(date)"
echo "📂 Server Dir: $SERVER_DIR"
echo "=========================================================="

# 1. Pre-Deployment Automated Database & Redis Snapshot
if [ -f "$SERVER_DIR/backup.sh" ]; then
    echo "📦 [1/5] Taking pre-update database snapshot..."
    bash "$SERVER_DIR/backup.sh" || echo "⚠️ Non-critical backup warning, continuing update..."
else
    echo "ℹ️ [1/5] backup.sh not found, skipping snapshot."
fi

# 2. Pull Latest Code from GitHub
echo "📥 [2/5] Fetching latest production commits from GitHub..."
cd "$SERVER_DIR"
if [ -d ".git" ]; then
    git fetch origin main
    git reset --hard origin/main
else
    echo "ℹ️ Not a standalone git repository. Skipping git pull."
fi

# 3. Ensure Strict Secret Permissions
if [ -f "$SERVER_DIR/.env" ]; then
    chmod 600 "$SERVER_DIR/.env"
fi

# 4. Install Dependencies & Compile Backend
echo "🔨 [3/5] Installing dependencies & compiling NestJS production bundle..."
npm install --production=false
npm run build

# 5. Seamless PM2 Hot-Reload (Zero-Downtime handover)
echo "⚡ [4/5] Executing zero-downtime process handover..."
if command -v pm2 >/dev/null 2>&1; then
    if pm2 describe skyrush-server >/dev/null 2>&1; then
        pm2 reload skyrush-server --update-env
        echo "✅ skyrush-server reloaded successfully without connection drops!"
    else
        pm2 start dist/main.js --name "skyrush-server"
        echo "✅ skyrush-server started fresh under PM2!"
    fi
    pm2 save
else
    echo "⚠️ PM2 not found in PATH. Please reload manually or install PM2 globally."
fi

# Optional: Full Stack Update if --all flag is provided
if [ "$1" == "--all" ]; then
    echo "🌐 [5/5] Updating Next.js Dashboard & Frontend Web..."
    
    # Update Dashboard
    if [ -d "$DASHBOARD_DIR" ]; then
        echo "🖥️ Updating Dashboard..."
        cd "$DASHBOARD_DIR"
        if [ -d ".git" ]; then
            git fetch origin main
            git reset --hard origin/main
        fi
        npm install --production=false
        npm run build
        if command -v pm2 >/dev/null 2>&1 && pm2 describe skyrush-dashboard >/dev/null 2>&1; then
            pm2 reload skyrush-dashboard --update-env
        fi
    fi

    # Update Flutter Web Game
    if [ -d "$GAME_DIR" ] && [ -x "/opt/flutter/bin/flutter" ]; then
        echo "🎮 Rebuilding Flutter Web Game..."
        cd "$GAME_DIR"
        /opt/flutter/bin/flutter build web --release --no-wasm-dry-run --no-tree-shake-icons
        mkdir -p "$GAME_WEB_DIR"
        cp -rf build/web/* "$GAME_WEB_DIR/"
        BUILD_TS=$(date +%s)
        sed -i "s/main\.dart\.js/main.dart.js?v=$BUILD_TS/g" "$GAME_WEB_DIR/flutter_bootstrap.js" 2>/dev/null || true
        sed -i "s/flutter_bootstrap\.js/flutter_bootstrap.js?v=$BUILD_TS/g" "$GAME_WEB_DIR/index.html" 2>/dev/null || true
        systemctl reload nginx 2>/dev/null || true
    fi
else
    echo "ℹ️ [5/5] Skipping frontend/dashboard build (Run with '--all' if full stack update is desired)."
fi

echo "=========================================================="
echo "🎉 ZERO-DOWNTIME UPDATE COMPLETED SUCCESSFULLY! 🎉"
echo "=========================================================="
if command -v pm2 >/dev/null 2>&1; then
    pm2 status skyrush-server
fi
