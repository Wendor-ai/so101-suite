#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_env.sh"
# usage: 02_setup_motors.sh follower|leader  (connect ONE motor at a time when prompted)
if [ "$1" = leader ]; then
  lerobot-setup-motors --teleop.type=so101_leader --teleop.port=$LEADER_PORT
else
  lerobot-setup-motors --robot.type=so101_follower --robot.port=$FOLLOWER_PORT
fi
