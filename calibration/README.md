# Calibration files

The app (and LeRobot) save your arm calibrations in `~/.cache/huggingface/lerobot/calibration/`.
This folder is only for **your own backups**, for moving a calibration to another computer:
`scripts/install_calibration.sh` copies `my_follower*.json` and `my_leader*.json` from here to the right place.

Files here are git-ignored on purpose. **Every arm is different**, so never copy somebody else's calibration onto your arm.
