#!/usr/bin/env sh
set -eu

cd /opt/work-assistant

profile="${WA_PROFILE:-personal-assistant}"
home="${DSH_HOME:-/data/dsh-home}"
workspace="${WA_WORKSPACE:-/workspace}"
memory_root="${WA_MEMORY_ROOT:-/workspace/memory}"
owner_id="${WA_OWNER_ID:-personal}"
time_zone="${WA_TIME_ZONE:?Set WA_TIME_ZONE to an IANA time zone}"
provider="${WA_PROVIDER:?Set WA_PROVIDER to the configured DSH provider route}"
model="${WA_MODEL:?Set WA_MODEL to the configured model id}"

if [ ! -d "$memory_root/.git" ]; then
  mkdir -p "$memory_root"
  git -C "$memory_root" init -b main
  git -C "$memory_root" -c commit.gpgSign=false -c user.name='Work Assistant' -c user.email='work-assistant@example.invalid' commit --allow-empty --no-verify -m 'initial memory root'
fi

set -- --home "$home" --profile "$profile" --workspace "$workspace" --owner-id "$owner_id" --memory-root "$memory_root" --provider "$provider" --model "$model" --time-zone "$time_zone"
if [ "${WA_CALENDAR_FEED_CREDENTIAL_REF:-}" != "" ]; then
  set -- "$@" --calendar-feed-credential-ref "$WA_CALENDAR_FEED_CREDENTIAL_REF"
else
  set -- "$@" --calendar-file "${WA_CALENDAR_FILE:-$workspace/calendar.ics}"
fi
if [ "${WA_SCHEDULE_ENABLED:-false}" = "true" ]; then
  set -- "$@" --enable-schedule --cron "${WA_CRON:?Set WA_CRON when WA_SCHEDULE_ENABLED=true}"
fi

node ./scripts/setup-personal-assistant.mjs "$@"
exec ./node_modules/.bin/dsh --profile "$profile" --no-open --host 0.0.0.0 --port 3080
