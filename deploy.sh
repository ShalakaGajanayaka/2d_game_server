#!/bin/bash
set -e

echo "=========================================================="
echo "🚀 SKYRUSH 2D - PRODUCTION GITHUB AUTO-DEPLOYMENT"
echo "=========================================================="

# 1. Update system packages
echo "📦 [1/8] Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl wget git build-essential ufw nginx postgresql postgresql-contrib redis-server unzip certbot python3-certbot-nginx

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

# 4. Clone / Pull Repositories from GitHub
echo "📁 [4/8] Cloning / Pulling source code from GitHub..."
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

# 5. Configure Production Secrets & PostgreSQL Database
echo "🐘 [5/8] Securing Secrets and Configuring PostgreSQL Database..."
systemctl start postgresql
systemctl enable postgresql

ENV_FILE="/var/www/skyrush/server/.env"

# If .env does not exist, generate high-entropy cryptographic production credentials
if [ ! -f "$ENV_FILE" ]; then
    echo "🔐 Generating cryptographic production credentials for .env..."
    GENERATED_DB_PASS=$(openssl rand -hex 16)
    GENERATED_ADMIN_PASS=$(openssl rand -hex 16)
    GENERATED_JWT_SECRET=$(openssl rand -hex 32)

    cat << EOF > "$ENV_FILE"
PORT=3000
NODE_ENV=production
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_TLS=false

DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=${GENERATED_DB_PASS}
DB_NAME=skyrush_db
ADMIN_USERNAME=admin@skyrush.cc
ADMIN_PASSWORD=${GENERATED_ADMIN_PASS}
ADMIN_JWT_SECRET=${GENERATED_JWT_SECRET}
# RESEND_API_KEY=re_your_rotated_resend_api_key
# EMAIL_FROM="SkyRush Security <noreply@skyrush.cc>"
EOF
    chmod 600 "$ENV_FILE"
    echo "🔑 Production secrets generated and saved to $ENV_FILE (chmod 600):"
    echo "   ADMIN_USERNAME: admin@skyrush.cc"
    echo "   ADMIN_PASSWORD: ${GENERATED_ADMIN_PASS}"
fi

# Extract DB_PASSWORD safely from .env for PostgreSQL setup
ACTIVE_DB_PASS=$(grep '^DB_PASSWORD=' "$ENV_FILE" | cut -d '=' -f2-)
if [ -z "$ACTIVE_DB_PASS" ]; then
    echo "❌ Error: DB_PASSWORD not found in $ENV_FILE"
    exit 1
fi

sudo -u postgres psql -c "ALTER USER postgres PASSWORD '$ACTIVE_DB_PASS';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'skyrush_db'" | grep -q 1 || sudo -u postgres psql -c "CREATE DATABASE skyrush_db;"

# 6. Build & Launch Backend Server
echo "🚀 [6/8] Building and Launching NestJS Backend..."
cd /var/www/skyrush/server
chmod 600 .env 2>/dev/null || true

npm install --production=false
npm run build

pm2 delete skyrush-server 2>/dev/null || true
pm2 start dist/main.js --name "skyrush-server"

# 7. Build & Launch Next.js Dashboard
echo "🖥️ [7/8] Building and Launching Next.js Dashboard..."
cd /var/www/skyrush/dashboard

cat << 'EOF' > .env.local
NEXT_PUBLIC_API_URL=https://engine.skyrush.cc
NEXT_PUBLIC_SOCKET_URL=https://engine.skyrush.cc
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
echo "SERVER_API_URL=https://engine.skyrush.cc" > .env
/opt/flutter/bin/flutter config --no-analytics
/opt/flutter/bin/flutter build web --release --no-wasm-dry-run --no-tree-shake-icons

mkdir -p /var/www/skyrush/game_web
rm -rf /var/www/skyrush/game_web/*
cp -rf build/web/* /var/www/skyrush/game_web/

BUILD_TS=$(date +%s)
sed -i "s/main\.dart\.js/main.dart.js?v=$BUILD_TS/g" /var/www/skyrush/game_web/flutter_bootstrap.js
sed -i "s/flutter_bootstrap\.js/flutter_bootstrap.js?v=$BUILD_TS/g" /var/www/skyrush/game_web/index.html

# Configure SSL Certificate Fallback (Cloudflare Origin CA or Self-Signed)
mkdir -p /etc/ssl/skyrush
if [ ! -f /etc/ssl/skyrush/certificate.crt ] || [ ! -f /etc/ssl/skyrush/private.key ]; then
    echo "🔐 Provisioning initial TLS/SSL certificate in /etc/ssl/skyrush/..."
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
        -keyout /etc/ssl/skyrush/private.key \
        -out /etc/ssl/skyrush/certificate.crt \
        -subj "/C=US/ST=Nevada/L=Las Vegas/O=SkyRush Gaming/CN=*.skyrush.cc"
    chmod 600 /etc/ssl/skyrush/private.key
    echo "ℹ️ Tip: For Cloudflare Full (Strict) SSL, paste your Cloudflare Origin Certificate into /etc/ssl/skyrush/certificate.crt and Key into /etc/ssl/skyrush/private.key"
fi

# Configure Nginx Reverse Proxy with Virtual Hosts & High-Security Hardening
cat << 'EOF' > /etc/nginx/sites-available/default
# ==========================================================
# SKYRUSH HIGH-SECURITY PRODUCTION NGINX CONFIGURATION
# ==========================================================
server_tokens off;

# 1. Anti-DDoS & Brute-Force Rate Limiting Zones
limit_req_zone $binary_remote_addr zone=skyrush_api:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=skyrush_auth:10m rate=5r/s;
limit_conn_zone $binary_remote_addr zone=skyrush_conn:10m;

# 2. Strict HTTP -> HTTPS 301 Redirection (All SkyRush Domains)
server {
    listen 80;
    listen [::]:80;
    server_name skyrush.cc www.skyrush.cc engine.skyrush.cc hq-ops-99.skyrush.cc;

    # Enforce immediate HTTPS redirection
    return 301 https://$host$request_uri;
}

# 3. Frontend Web Game (skyrush.cc & www.skyrush.cc)
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name skyrush.cc www.skyrush.cc;

    root /var/www/skyrush/game_web;
    index index.html;

    # TLS / SSL Configuration
    ssl_certificate /etc/ssl/skyrush/certificate.crt;
    ssl_certificate_key /etc/ssl/skyrush/private.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_session_cache shared:SSL:20m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # High-Security Response Headers (HSTS, Anti-Clickjacking, MIME Sniffing)
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    # Aggressive No-Cache for iOS Web Clip & PWA entry points
    location ~* (index\.html|manifest\.json)$ {
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0";
        expires -1;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /socket.io/ {
        limit_conn skyrush_conn 30;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location /auth/ {
        limit_req zone=skyrush_auth burst=10 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}

# 4. Game Engine Realtime Backend (engine.skyrush.cc)
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name engine.skyrush.cc;

    # TLS / SSL Configuration
    ssl_certificate /etc/ssl/skyrush/certificate.crt;
    ssl_certificate_key /etc/ssl/skyrush/private.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_session_cache shared:SSL:20m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        limit_req zone=skyrush_api burst=50 nodelay;
        limit_conn skyrush_conn 50;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}

# 5. Secret Admin Mission Control (hq-ops-99.skyrush.cc)
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name hq-ops-99.skyrush.cc;

    # TLS / SSL Configuration
    ssl_certificate /etc/ssl/skyrush/certificate.crt;
    ssl_certificate_key /etc/ssl/skyrush/private.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_session_cache shared:SSL:20m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        limit_req zone=skyrush_api burst=30 nodelay;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}

# 6. Origin Shield & Port-Scan Drop (Catch-all for direct IP scans on HTTP & HTTPS)
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    server_tokens off;

    ssl_certificate /etc/ssl/skyrush/certificate.crt;
    ssl_certificate_key /etc/ssl/skyrush/private.key;

    # Instantly drop direct IP scans, botnets, and unmapped Host headers
    return 444;
}
EOF

nginx -t
systemctl restart nginx

# Automated Daily Database & Redis Backups at 3:00 AM
chmod +x /var/www/skyrush/server/backup.sh 2>/dev/null || true
(crontab -l 2>/dev/null | grep -v "/var/www/skyrush/server/backup.sh" ; echo "0 3 * * * /var/www/skyrush/server/backup.sh >/dev/null 2>&1") | crontab -

# Firewall Setup - Lock down raw backend ports to protect origin IP
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw delete allow 3000/tcp 2>/dev/null || true
ufw delete allow 3001/tcp 2>/dev/null || true
echo "y" | ufw enable || true

echo "=========================================================="
echo "🎉 DEPLOYMENT SUCCESSFUL! SKYRUSH 2D IS NOW LIVE! 🎉"
echo "=========================================================="
echo "🎮 SkyRush Game (Web):     https://skyrush.cc"
echo "⚡ Realtime Game Engine:   https://engine.skyrush.cc"
echo "📊 Secret Admin Control:   https://hq-ops-99.skyrush.cc"
echo "=========================================================="

