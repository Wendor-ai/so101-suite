#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_env.sh"
# Apple Silicon: device=mps. For serious training use a CUDA GPU/Colab.
lerobot-train --dataset.repo_id=$DATASET_REPO --policy.type=act \
  --output_dir=outputs/train/act_so101 --job_name=act_so101 \
  --policy.device=mps --policy.repo_id=$HF_USER/act_so101 --wandb.enable=false
