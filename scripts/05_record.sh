#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_env.sh"
# Requires: huggingface-cli login (or --dataset.push_to_hub=false)
lerobot-record \
  --robot.type=so101_follower --robot.port=$FOLLOWER_PORT --robot.id=$FOLLOWER_ID \
  --robot.cameras="{ front: {type: opencv, index_or_path: $CAMERA_INDEX, width: 640, height: 480, fps: 30}}" \
  --teleop.type=so101_leader --teleop.port=$LEADER_PORT --teleop.id=$LEADER_ID \
  --dataset.repo_id=$DATASET_REPO --dataset.num_episodes=${1:-20} \
  --dataset.single_task="${TASK:-Pick up the object}" --display_data=true
