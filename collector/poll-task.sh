#!/bin/bash
# NanoClaw scheduled-task hook: run one collector poll; wake the agent only
# after 3 consecutive failures (transient network blips self-heal at 5-min cadence).
DIR=/workspace/ig-bot/projects/tfl-delay-repay/collector
FAILFILE=$DIR/.consecutive-failures
out=$(cd "$DIR" && node collector.mjs 2>&1)
if [ $? -eq 0 ]; then
  rm -f "$FAILFILE"
  echo '{"wakeAgent": false}'
else
  n=$(( $(cat "$FAILFILE" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$FAILFILE"
  if [ "$n" -ge 3 ]; then
    node -e "console.log(JSON.stringify({wakeAgent:true,data:{consecutiveFailures:$n,lastError:process.argv[1].slice(-400)}}))" "$out"
  else
    echo '{"wakeAgent": false}'
  fi
fi
