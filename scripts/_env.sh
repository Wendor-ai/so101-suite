cd "$(dirname "$0")/.."
source .venv/bin/activate
# Your settings live in .env (git-ignored; copy .env.example). The real environment wins over the file. Same reader as the app.
eval "$(so101 env --shell)"
if [ -f config.sh ]; then echo "note: config.sh is replaced by .env (see .env.example); reading config.sh this time" >&2; source config.sh; fi
export FOLLOWER_PORT="${FOLLOWER_PORT:-/dev/ttyACM0}" LEADER_PORT="${LEADER_PORT:-/dev/ttyACM1}"
export FOLLOWER_ID="${FOLLOWER_ID:-my_follower}" LEADER_ID="${LEADER_ID:-my_leader}" CAMERA_INDEX="${CAMERA_INDEX:-0}"
export HF_USER="${HF_USER:-your-hf-username}"; export DATASET_REPO="${DATASET_REPO:-${HF_USER}/so101_task}"
