#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_env.sh"
lerobot-record \
  --robot.type=so101_follower --robot.port=$FOLLOWER_PORT --robot.id=$FOLLOWER_ID \
  --robot.cameras="{ front: {type: opencv, index_or_path: $CAMERA_INDEX, width: 640, height: 480, fps: 30}}" \
  --dataset.repo_id=${HF_USER}/eval_so101 --dataset.single_task="${TASK:-Pick up the object}" \
  --policy.path=${1:-outputs/train/act_so101/checkpoints/last/pretrained_model}
