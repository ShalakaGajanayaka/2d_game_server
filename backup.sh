#!/bin/bash
set -e

BACKUP_DIR="/var/backups/skyrush"
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
DB_BACKUP="$BACKUP_DIR/skyrush_db_$TIMESTAMP.sql.gz"
REDIS_BACKUP="$BACKUP_DIR/skyrush_redis_$TIMESTAMP.rdb"

echo "📦 [1/3] Dumping PostgreSQL database 'skyrush_db'..."
sudo -u postgres pg_dump skyrush_db | gzip > "$DB_BACKUP"
chmod 600 "$DB_BACKUP"

echo "⚡ [2/3] Taking Redis snapshot..."
redis-cli bgsave || true
sleep 2
if [ -f /var/lib/redis/dump.rdb ]; then
    cp /var/lib/redis/dump.rdb "$REDIS_BACKUP"
    chmod 600 "$REDIS_BACKUP"
fi

echo "🧹 [3/3] Rotating old backups (keeping last 7 days)..."
find "$BACKUP_DIR" -type f -name "skyrush_*" -mtime +7 -delete

echo "✅ Backup completed successfully at $(date):"
ls -lh "$BACKUP_DIR" | tail -n 5
