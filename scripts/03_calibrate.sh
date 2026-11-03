#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_env.sh"
# usage: 03_calibrate.sh follower|leader
if [ "$1" = leader ]; then
  lerobot-calibrate --teleop.type=so101_leader --teleop.port=$LEADER_PORT --teleop.id=$LEADER_ID
else
  lerobot-calibrate --robot.type=so101_follower --robot.port=$FOLLOWER_PORT --robot.id=$FOLLOWER_ID
fi
