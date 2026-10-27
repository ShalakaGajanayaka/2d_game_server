#!/bin/bash
set -e

# ========================================================
# SkyRush 2D - Enterprise Database Backup & Archival Engine
# Supports: PostgreSQL, Redis, Integrity Hashing, Offsite Cloud Sync
# ========================================================

BACKUP_DIR="/var/backups/skyrush"
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
DB_BACKUP="$BACKUP_DIR/skyrush_db_$TIMESTAMP.sql.gz"
REDIS_BACKUP="$BACKUP_DIR/skyrush_redis_$TIMESTAMP.rdb"
LOG_FILE="$BACKUP_DIR/backup.log"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=========================================================="
log "🚀 Starting SkyRush System Database Backup..."

# 1. PostgreSQL Database Dump
log "📦 [1/4] Dumping PostgreSQL database 'skyrush_db'..."
sudo -u postgres pg_dump skyrush_db | gzip > "$DB_BACKUP"
chmod 600 "$DB_BACKUP"

# Verify gzip archive integrity
log "🔍 Verifying dump archive integrity..."
if gzip -t "$DB_BACKUP"; then
    DB_SIZE=$(du -h "$DB_BACKUP" | cut -f1)
    DB_HASH=$(sha256sum "$DB_BACKUP" | cut -d' ' -f1)
    log "✅ PostgreSQL dump verified clean! Size: $DB_SIZE | SHA256: ${DB_HASH:0:16}..."
else
    log "❌ FATAL: PostgreSQL backup archive is corrupted or truncated!"
    exit 1
fi

# 2. Redis In-Memory Snapshot
log "⚡ [2/4] Triggering Redis background snapshot..."
redis-cli bgsave || true
sleep 3
if [ -f /var/lib/redis/dump.rdb ]; then
    cp /var/lib/redis/dump.rdb "$REDIS_BACKUP"
    chmod 600 "$REDIS_BACKUP"
    REDIS_SIZE=$(du -h "$REDIS_BACKUP" | cut -f1)
    log "✅ Redis snapshot archived. Size: $REDIS_SIZE"
fi

# 3. Offsite Cloud Backup Sync (Optional AWS S3 / Cloudflare R2 / Rclone)
log "☁️ [3/4] Checking for configured Cloud / Offsite storage..."
if [ -n "$S3_BACKUP_BUCKET" ] && command -v aws &> /dev/null; then
    log "📤 Uploading to AWS S3 bucket: s3://$S3_BACKUP_BUCKET..."
    aws s3 cp "$DB_BACKUP" "s3://$S3_BACKUP_BUCKET/db/"
    [ -f "$REDIS_BACKUP" ] && aws s3 cp "$REDIS_BACKUP" "s3://$S3_BACKUP_BUCKET/redis/"
    log "✅ Cloud upload to S3 complete!"
elif [ -n "$RCLONE_DESTINATION" ] && command -v rclone &> /dev/null; then
    log "📤 Syncing to Rclone remote: $RCLONE_DESTINATION..."
    rclone copy "$DB_BACKUP" "$RCLONE_DESTINATION/db/"
    [ -f "$REDIS_BACKUP" ] && rclone copy "$REDIS_BACKUP" "$RCLONE_DESTINATION/redis/"
    log "✅ Rclone remote sync complete!"
else
    log "ℹ️ No offsite cloud bucket configured. Backups stored securely on local disk: $BACKUP_DIR"
    log "   (To enable cloud backup, export S3_BACKUP_BUCKET='your-bucket-name' or RCLONE_DESTINATION)"
fi

# 4. Retention Policy (7 Days Rotation)
log "🧹 [4/4] Purging local backups older than 7 days..."
find "$BACKUP_DIR" -type f -name "skyrush_*" -mtime +7 -delete

log "🎉 SkyRush Backup routine completed successfully!"
ls -lh "$BACKUP_DIR" | tail -n 5
