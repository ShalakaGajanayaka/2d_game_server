#!/bin/bash
set -e

echo "=========================================================="
echo "🚀 SKYRUSH AVIATOR 2D - PRODUCTION GITHUB AUTO-DEPLOYMENT"
echo "=========================================================="

# 1. Update system packages
echo "📦 [1/8] Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl wget git build-essential ufw nginx postgresql postgresql-contrib redis-server

# 2. Install Node.js 20 LTS and PM2
echo "📦 [2/8] Installing Node.js 20 LTS and PM2..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1 | sed 's/v//') -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
npm install -g pm2

# 3. Configure and Start Redis
echo "⚡ [3/8] Starting Redis..."
systemctl start redis-server
systemctl enable redis-server

# 4. Configure PostgreSQL
echo "🐘 [4/8] Configuring PostgreSQL Database..."
systemctl start postgresql
systemctl enable postgresql

# Set password for postgres user and create skyrush_db if not exists
sudo -u postgres psql -c "ALTER USER postgres PASSWORD '12345678';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'skyrush_db'" | grep -q 1 || sudo -u postgres psql -c "CREATE DATABASE skyrush_db;"

# 5. Clone / Pull Repositories from GitHub
echo "📁 [5/8] Cloning / Pulling source code from GitHub..."
mkdir -p /var/www/skyrush
cd /var/www/skyrush
git config --global credential.helper store

# Backend Server
if [ -d "server/.git" ]; then
    echo "🔄 Updating Server from GitHub..."
    cd server && git pull origin main && cd ..
else
    echo "📥 Cloning Server from GitHub..."
    git clone https://github.com/ShalakaGajanayaka/2d_game_server.git server
fi

# Dashboard
if [ -d "dashboard" ] && [ ! -d "dashboard/.git" ]; then
    rm -rf dashboard
fi
if [ -d "dashboard/.git" ]; then
    echo "🔄 Updating Dashboard from GitHub..."
    cd dashboard && git pull origin main && cd ..
else
    echo "📥 Cloning Dashboard from GitHub..."
    git clone https://github.com/ShalakaGajanayaka/casino_dashboard.git dashboard
fi

# Game App
if [ -d "game_app" ] && [ ! -d "game_app/.git" ]; then
    rm -rf game_app
fi
if [ -d "game_app/.git" ]; then
    echo "🔄 Updating Game App from GitHub..."
    cd game_app && git pull origin main && cd ..
else
    echo "📥 Cloning Game App from GitHub..."
    git clone https://github.com/ShalakaGajanayaka/2d_game_app.git game_app
fi

# 6. Build & Launch Backend Server
echo "🚀 [6/8] Building and Launching NestJS Backend..."
cd /var/www/skyrush/server

cat << 'EOF' > .env
PORT=3000
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_TLS=false

DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=12345678
DB_NAME=skyrush_db
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
ADMIN_JWT_SECRET=supersecretadminjwt_prod_key_2026
EOF

npm install --production=false
npm run build

pm2 delete skyrush-server 2>/dev/null || true
pm2 start dist/main.js --name "skyrush-server"

# 7. Build & Launch Next.js Dashboard
echo "🖥️ [7/8] Building and Launching Next.js Dashboard..."
cd /var/www/skyrush/dashboard

cat << 'EOF' > .env.local
NEXT_PUBLIC_API_URL=http://94.136.190.213:3000
NEXT_PUBLIC_SOCKET_URL=http://94.136.190.213:3000
EOF

npm install --production=false
npm run build

pm2 delete skyrush-dashboard 2>/dev/null || true
pm2 start npm --name "skyrush-dashboard" -- start -- -p 3001

# Save PM2 process list & setup autostart on reboot
pm2 save
env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root || true

# 8. Build Flutter Web App & Configure Nginx
echo "🎮 [8/8] Building Flutter Web Game & Configuring Nginx..."
if [ ! -d "/opt/flutter" ]; then
    echo "📦 Downloading Flutter SDK for Linux..."
    git clone --depth 1 -b stable https://github.com/flutter/flutter.git /opt/flutter
fi

export PATH="$PATH:/opt/flutter/bin"
git config --global --add safe.directory /opt/flutter

cd /var/www/skyrush/game_app
/opt/flutter/bin/flutter config --no-analytics
/opt/flutter/bin/flutter build web --release

mkdir -p /var/www/skyrush/game_web
cp -rf build/web/* /var/www/skyrush/game_web/

# Configure Nginx Reverse Proxy
cat << 'EOF' > /etc/nginx/sites-available/default
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Flutter Game Web App
    root /var/www/skyrush/game_web;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # WebSocket & Realtime Socket.IO
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }

    # Backend Auth & Game APIs
    location /auth/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Backend Admin APIs
    location /admin/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
EOF

nginx -t
systemctl restart nginx

# Firewall Setup
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw allow 3001/tcp
echo "y" | ufw enable || true

echo "=========================================================="
echo "🎉 DEPLOYMENT SUCCESSFUL! SKYRUSH AVIATOR IS NOW LIVE! 🎉"
echo "=========================================================="
echo "🎮 Aviator Game (Web):     http://94.136.190.213"
echo "📊 Mission Control Admin:  http://94.136.190.213:3001"
echo "⚡ Backend API (Socket):   http://94.136.190.213:3000"
echo "=========================================================="
