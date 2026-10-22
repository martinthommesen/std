#!/bin/bash
# Exercises forks, pipelines, execve, execveat, long arguments and escapes.
echo hi | jq -n --arg p 'a"b\c
d' . >/dev/null 2>&1 || true
/bin/true "$(printf 'x%.0s' $(seq 1 300))" "tab	é"
( /bin/true one two ) &
wait
for round in 1 2 3; do
  /bin/echo "$round" | cat | cat | cat >/dev/null
done
python3 -c 'import os; fd = os.open("/bin/true", os.O_RDONLY); os.execve(fd, ["true", "via-fd"], {})'
/nonexistent/thing 2>/dev/null || true
