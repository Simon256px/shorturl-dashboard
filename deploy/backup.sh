#!/usr/bin/env bash
#
# Consistent backup of the SQLite database while the service keeps serving.
#
#   sudo ./backup.sh /var/backups/shorturl
#
# `sqlite3 .backup` uses the online backup API, so it produces a coherent
# snapshot even mid-write — unlike `cp`, which can capture a torn file when the
# WAL is being checkpointed.

set -euo pipefail

DB=${DB:-/var/lib/shorturl/shorturl.db}
DEST=${1:-/var/backups/shorturl}
KEEP=${KEEP:-14}

command -v sqlite3 >/dev/null || {
	echo "sqlite3 is missing — dnf install sqlite" >&2
	exit 1
}
[[ -f "$DB" ]] || {
	echo "no database at $DB" >&2
	exit 1
}

mkdir -p "$DEST"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DEST/shorturl-$STAMP.db"

sqlite3 "$DB" ".backup '$OUT'"
# Fold the WAL into the copy so the backup is a single self-contained file.
sqlite3 "$OUT" "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"
gzip -9 "$OUT"

chmod 0600 "$OUT.gz"
echo "wrote $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"

# Retention
find "$DEST" -name 'shorturl-*.db.gz' -type f -printf '%T@ %p\n' |
	sort -rn | tail -n "+$((KEEP + 1))" | cut -d' ' -f2- |
	while read -r old; do
		echo "removing $old"
		rm -f "$old"
	done
