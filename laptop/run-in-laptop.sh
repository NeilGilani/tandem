#!/bin/bash
# A Bot's shell commands run on its laptop, not on this Mac. Claude Code hands this
# script one string: its Mac shell setup, the command, and a write of the final working
# folder to a file it reads afterwards.
cmd="$1"
name="${TANDEM_LAPTOP:?no laptop}"
home="${TANDEM_LAPTOP_HOME:?no laptop home}"
export DOCKER_HOST="${TANDEM_DOCKER_HOST:?no docker host}"
docker=/opt/homebrew/bin/docker; [ -x "$docker" ] || docker=$(command -v docker)

# Only the Bot's own commands go to the laptop. They end by writing the working folder to
# a file; anything else (Claude Code starting its tool servers) runs here on the Mac.
cwdfile=$(printf '%s' "$cmd" | sed -nE 's#.*pwd -P >\| ([^ ]+)$#\1#p')
if [ -z "$cwdfile" ]; then exec /bin/bash -c "$cmd"; fi

# Mac shell setup (paths, aliases) doesn't apply on the laptop.
cmd=$(printf '%s' "$cmd" | sed -E '1s#^source [^ ]+ 2>/dev/null \|\| true && ##')

# Write the working folder somewhere both sides can see, then hand it back.
mkdir -p "$home/.tandem"
tmp="$home/.tandem/cwd-$$"
cmd="${cmd/>| $cwdfile/>| $tmp}"

start=$(printf '%q' "$PWD")
"$docker" exec -e DISPLAY=:1 "$name" bash -c "cd $start 2>/dev/null || cd \"\$HOME\"; $cmd"
code=$?
if [ -f "$tmp" ]; then cat "$tmp" > "$cwdfile"; rm -f "$tmp"; fi
exit $code
